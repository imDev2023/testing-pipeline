//! The four keeper jobs, and when each is due (docs/spec/pool4-for-solana.md, "For the
//! keeper runner"). [`due`] is the program's own rule, from this tree's pure functions, read
//! off the market state: `place_wall` once idle SOL or the wall's converted SOL reaches
//! `WALL_THRESHOLD`, `settle` with tokens retired, `pay_rewards` with rewards owed, and
//! `sweep_fees` for each slot whose ledger is above 0 and whose wallet is set (slot 1 only
//! once `DESIGNER_RECIPIENT` is).
//!
//! This tree is the candidate's, so its rules alone would let a candidate that narrows a
//! rule drop that job from its own test. The gate therefore also runs every job the deployed
//! build ran on the snapshot ([`crate::check`]): it tries each of the four, every slot of
//! `sweep_fees` on its own, with the deployed build and records which ran.

use buy_wall_amm::state::{MarketState, STATUS_OPEN};
use pipeline_client::pda;
use serde::{Deserialize, Serialize};
use solana_signer::Signer;

use crate::session::{
    key, pay_rewards_ix, place_wall_ix, settle_ix, sweep_fees_ix, MarketView, Session, TOKEN, WSOL,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(into = "String", try_from = "String")]
pub enum Job {
    PlaceWall,
    Settle,
    PayRewards,
    SweepFees(u8),
}

impl Job {
    /// Every job, in the order the runner sends them.
    pub const ALL: [Job; 6] = [
        Job::PlaceWall,
        Job::Settle,
        Job::PayRewards,
        Job::SweepFees(0),
        Job::SweepFees(1),
        Job::SweepFees(2),
    ];
}

impl From<Job> for String {
    fn from(job: Job) -> String {
        job.to_string()
    }
}

impl TryFrom<String> for Job {
    type Error = String;

    fn try_from(text: String) -> Result<Job, String> {
        Job::ALL
            .into_iter()
            .find(|job| job.to_string() == text)
            .ok_or_else(|| format!("{text:?} is not a keeper job"))
    }
}

impl std::fmt::Display for Job {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Job::PlaceWall => write!(f, "place_wall"),
            Job::Settle => write!(f, "settle"),
            Job::PayRewards => write!(f, "pay_rewards"),
            Job::SweepFees(slot) => write!(f, "sweep_fees {{ slot: {slot} }}"),
        }
    }
}

/// Every job due on `state`, in the order the runner would send them.
pub fn due(state: &MarketState) -> Vec<Job> {
    if state.status != STATUS_OPEN {
        return vec![];
    }
    let owed = state.owed();
    let mut jobs = vec![];
    if buy_wall_amm::wall::place(state.wall_books(), state.wall_at()).is_ok() {
        jobs.push(Job::PlaceWall);
    }
    if owed.settle(state.reward_share_bps()).is_ok() {
        jobs.push(Job::Settle);
    }
    if owed.pay_rewards(&state.rewards_recipient).is_ok() {
        jobs.push(Job::PayRewards);
    }
    for slot in 0..3 {
        if owed.sweep(slot, &state.fee_recipient).is_ok() {
            jobs.push(Job::SweepFees(slot));
        }
    }
    jobs
}

/// Sends `job`, as our keeper runner would; what it did, or why it failed.
pub fn run(
    session: &mut Session,
    view: &MarketView,
    state: &MarketState,
    job: Job,
) -> Result<String, String> {
    let program = session.program;
    let payer = session.payer.pubkey();
    match job {
        Job::PlaceWall => {
            let keeper = session.keeper(&view.market_state)?;
            let tips = pda::associated_token(&keeper.pubkey(), &WSOL, &TOKEN);
            let ix = place_wall_ix(&program, view, &keeper.pubkey(), &tips);
            session.send(&[ix], &[&keeper])?;
            Ok(format!(
                "tipped {}",
                session.balance(&tips).unwrap_or_default()
            ))
        }
        Job::Settle => {
            session.send(&[settle_ix(&program, view)], &[])?;
            Ok(format!("settled {}", state.retired_tokens()))
        }
        Job::PayRewards => {
            let recipient = key(&state.rewards_recipient);
            let token = view.token_index();
            let to =
                pda::associated_token(&recipient, &view.mints[token], &view.token_programs[token]);
            let hooks = session.hook_accounts(
                &view.mints[token],
                view.vaults[token],
                to,
                view.vault_authority,
            )?;
            session.send(
                &[pay_rewards_ix(&program, view, &payer, &recipient, hooks)],
                &[],
            )?;
            Ok(format!("paid {}", state.rewards_owed()))
        }
        Job::SweepFees(slot) => {
            let wallet = buy_wall_amm::payouts::slot_wallet(slot, &state.fee_recipient)
                .map_err(|refusal| format!("slot {slot} has no wallet: {refusal:?}"))?;
            let ix = sweep_fees_ix(&program, view, &payer, &key(&wallet), slot);
            session.send(&[ix], &[])?;
            Ok("swept".into())
        }
    }
}
