//! `token_authorities`: for each of the market's mints, acts as each authority that exists
//! and then trades again (`CANARY-17`; `docs/spec/pipescope-canary.md`, "Control").
//!
//! What each authority does, when it is a wallet (signature checks are off in the copy, so
//! Canary can sign as it), each from a fresh copy:
//!
//! - **Mint authority**: mints [`MINT_AUTHORITY_MULTIPLE`] times what the market's vault
//!   holds of that mint and sells it all into each other mint; the figure is the share of
//!   that mint's vault taken.
//! - **Freeze authority**: after a buy of the reference size, freezes the buyer's account of
//!   that mint, then tries the sale.
//! - **Transfer-fee authority**: sets the fee to [`TRANSFER_FEE_ACTING_BPS`] with no maximum,
//!   moves the clock [`TRANSFER_FEE_EPOCHS_ON`] epochs on so the fee applies, then
//!   round-trips the reference size.
//! - **Permanent delegate**: after a buy, moves the buyer's whole balance of that mint away
//!   (for the money side's mint, after the sale, when the buyer holds it), then tries the
//!   sale.
//! - **Pause authority**: after a buy, pauses the mint, then tries the sale.
//!
//! An authority that is a program's address is "not run", naming the program that owns it,
//! because only that program's own instructions can use it.
//!
//! - Fail: never: it depends on an authority acting.
//! - Warn: an authority exists and its action took from the market or stopped or emptied a
//!   trade; the figure is reported.
//! - Pass: no mint has such an authority, or acting as each changed no trade.
//! - "Not run" when the market refuses every trade, or every authority is a program's.

use litesvm::LiteSVM;
use pipeline_check::write_token_account;
use pipeline_client::{Instruction, Pubkey};
use pipeline_strategy_interface::{fees, BPS_DENOMINATOR};
use serde::Serialize;
use serde_json::json;
use solana_clock::Clock;
use solana_transaction::Transaction;
use spl_token_2022_interface::extension::{pausable, transfer_fee};
use spl_token_2022_interface::instruction as token;

use crate::bands::{band, Band};
use crate::checks::readable::Trading;
use crate::config::{
    MINT_AUTHORITY_MULTIPLE, PPM, SLOTS_PER_EPOCH, SLOTS_PER_SECOND_DENOMINATOR,
    SLOTS_PER_SECOND_NUMERATOR, TRANSFER_FEE_ACTING_BPS, TRANSFER_FEE_EPOCHS_ON,
};
use crate::failure::{Failure, Stage};
use crate::market::{fund_lamports, token_amount, MintFacts, Session};
use crate::record::{Outcome, Verdict};
use crate::swap::SwapPath;
use crate::trade::{Leg, RoundTrip};

/// A token authority's power.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Power {
    MintAuthority,
    FreezeAuthority,
    TransferFeeAuthority,
    PermanentDelegate,
    PauseAuthority,
}

impl Power {
    pub fn words(self) -> &'static str {
        match self {
            Power::MintAuthority => "mint authority",
            Power::FreezeAuthority => "freeze authority",
            Power::TransferFeeAuthority => "transfer-fee authority",
            Power::PermanentDelegate => "permanent delegate",
            Power::PauseAuthority => "pause authority",
        }
    }
}

/// The authorities of `mint`, in the order Canary acts as them.
pub fn authorities(mint: &MintFacts) -> Vec<(Power, Pubkey)> {
    [
        (Power::MintAuthority, mint.mint_authority),
        (Power::FreezeAuthority, mint.freeze_authority),
        (
            Power::TransferFeeAuthority,
            mint.transfer_fee
                .and_then(|c| Option::<Pubkey>::from(c.transfer_fee_config_authority)),
        ),
        (Power::PermanentDelegate, mint.permanent_delegate),
        (Power::PauseAuthority, mint.pause_authority),
    ]
    .into_iter()
    .filter_map(|(power, key)| key.map(|key| (power, key)))
    .collect()
}

/// Whether `key` is a wallet, one a private key can sign for: on the curve, and not an
/// account a program owns. Otherwise the program that owns it, if it has an account.
pub fn wallet_or_owner(svm: &LiteSVM, key: &Pubkey) -> Result<(), Option<Pubkey>> {
    let account = svm.get_account(key);
    let owner = account.as_ref().map(|a| a.owner);
    let system_or_none = owner.is_none_or(|o| o == pipeline_client::SYSTEM_PROGRAM_ID);
    if key.is_on_curve() && system_or_none {
        Ok(())
    } else {
        Err(owner.filter(|o| *o != pipeline_client::SYSTEM_PROGRAM_ID))
    }
}

/// One sale of minted tokens into another mint.
#[derive(Clone, Debug, Serialize)]
pub struct Sale {
    pub output: usize,
    pub vault_before: u64,
    pub received: Option<u64>,
    pub share_of_vault_ppm: Option<u64>,
    pub leg: Leg,
}

/// What acting as one authority did.
#[derive(Clone, Debug, Serialize)]
pub struct Action {
    pub mint: usize,
    pub mint_address: String,
    pub power: Power,
    pub authority: String,
    /// "not run" when Canary could not act; otherwise what it did, with `effect`.
    pub outcome: &'static str,
    /// Why it was not run.
    pub reason: Option<String>,
    /// The program that owns an authority that is not a wallet.
    pub owner: Option<String>,
    /// Whether the action took from the market or stopped or emptied a trade.
    pub effect: bool,
    /// The authority's own instruction, when it failed.
    pub refused: Option<Failure>,
    /// Mint authority: what it minted, and each sale of it.
    pub minted: Option<u64>,
    pub sales: Vec<Sale>,
    /// The round trip the action came between (or, for a transfer fee, before).
    pub round_trip: Option<RoundTrip>,
    /// Permanent delegate: what it moved away from the buyer.
    pub moved: Option<u64>,
    pub return_ppm: Option<u64>,
}

impl Action {
    fn new(market_mint: &MintFacts, mint: usize, power: Power, authority: Pubkey) -> Self {
        Action {
            mint,
            mint_address: market_mint.address.to_string(),
            power,
            authority: authority.to_string(),
            outcome: "acted",
            reason: None,
            owner: None,
            effect: false,
            refused: None,
            minted: None,
            sales: vec![],
            round_trip: None,
            moved: None,
            return_ppm: None,
        }
    }

    fn not_run(mut self, reason: String) -> Self {
        self.outcome = "not run";
        self.reason = Some(reason);
        self
    }
}

/// What `token_authorities` measured.
#[derive(Clone, Debug, Serialize)]
pub struct Measured {
    pub money: usize,
    /// How the reasons name each mint: its index, and "wrapped SOL" for wrapped SOL.
    pub mint_names: Vec<String>,
    /// Each mint's decimals, to say amounts in whole tokens.
    pub decimals: Vec<u8>,
    pub reference: u64,
    pub reference_words: String,
    pub actions: Vec<Action>,
}

/// Sends `ix` signed (in the copy) by `authority`.
fn act(
    svm: &mut LiteSVM,
    session: &Session,
    authority: &Pubkey,
    ix: Instruction,
) -> Result<(), Failure> {
    fund_lamports(svm, authority);
    let mut tx = Transaction::new_with_payer(&[ix], Some(authority));
    tx.message.recent_blockhash = svm.latest_blockhash();
    svm.send_transaction(tx).map(|_| ()).map_err(|failed| {
        Failure::from_transaction(Stage::AuthorityAction, &session.market.strategy(), &failed)
    })
}

/// Moves the clock `epochs` on, slot and Unix time with it at the configured clock rates.
fn move_epochs(svm: &mut LiteSVM, epochs: u64) {
    let mut clock: Clock = svm.get_sysvar();
    let slots = epochs * SLOTS_PER_EPOCH;
    clock.slot += slots;
    clock.epoch += epochs;
    clock.unix_timestamp +=
        (slots * SLOTS_PER_SECOND_DENOMINATOR / SLOTS_PER_SECOND_NUMERATOR) as i64;
    svm.set_sysvar(&clock);
}

fn share_ppm(part: u64, whole: u64) -> Option<u64> {
    (whole > 0).then(|| ((part as u128 * PPM as u128) / whole as u128).min(u64::MAX as u128) as u64)
}

/// When an authority acts in a round trip.
enum Moment {
    BeforeBuy,
    AfterBuy,
    AfterSale,
}

/// Acts as every authority of every mint that exists.
pub fn measure(
    session: &mut Session,
    path: &dyn SwapPath,
    money: usize,
    reference: u64,
    reference_words: String,
) -> Measured {
    let mut actions = vec![];
    let mints = session.market.mints.clone();
    for (i, mint) in mints.iter().enumerate() {
        for (power, authority) in authorities(mint) {
            let action = Action::new(mint, i, power, authority);
            if let Err(owner) = wallet_or_owner(session.base(), &authority) {
                let whose = match owner {
                    Some(owner) => format!("an address owned by the program {owner}"),
                    None => "a program-derived address".to_string(),
                };
                let mut action = action.not_run(format!(
                    "mint {i}'s {} is {whose}, which only that program's own instructions can use",
                    power.words()
                ));
                action.owner = owner.map(|o| o.to_string());
                actions.push(action);
                continue;
            }
            actions.push(match power {
                Power::MintAuthority => mint_and_sell(session, path, action, &authority),
                _ => act_in_round_trip(session, path, action, &authority, money, reference),
            });
        }
    }
    Measured {
        money,
        mint_names: mints
            .iter()
            .enumerate()
            .map(|(i, m)| {
                if m.is_wrapped_sol() {
                    format!("mint {i} (wrapped SOL)")
                } else {
                    format!("mint {i}")
                }
            })
            .collect(),
        decimals: mints.iter().map(|m| m.decimals).collect(),
        reference,
        reference_words,
        actions,
    }
}

fn mint_and_sell(
    session: &mut Session,
    path: &dyn SwapPath,
    mut action: Action,
    authority: &Pubkey,
) -> Action {
    let i = action.mint;
    let mut svm = session.fresh();
    let mint = session.market.mints[i].clone();
    let vault = token_amount(&svm, &session.market.vault(i)).unwrap_or(0);
    let room = u64::MAX - mint.supply;
    let minted = vault.saturating_mul(MINT_AUTHORITY_MULTIPLE).min(room);
    if minted == 0 {
        return action.not_run(format!("the market's vault of mint {i} is empty, so there is nothing to mint {MINT_AUTHORITY_MULTIPLE} times"));
    }
    fund_lamports(&mut svm, authority);
    for j in 0..session.market.len() {
        if let Err(error) = write_token_account(
            &mut svm,
            &session.market.mint(j),
            &session.market.token_program(j),
            authority,
            0,
        ) {
            session.notes.push(format!(
                "could not open the mint authority's accounts: {error}"
            ));
        }
    }
    let ix = token::mint_to_checked(
        &mint.token_program,
        &mint.address,
        &session.market.ata(authority, i),
        authority,
        &[],
        minted,
        mint.decimals,
    )
    .expect("both token programs take mint_to_checked");
    if let Err(failure) = act(&mut svm, session, authority, ix) {
        action.refused = Some(failure.clone());
        return action.not_run(format!("minting was refused ({failure})"));
    }
    action.minted = Some(minted);
    let amount = fees::amount_for_budget(minted, 0);
    for j in (0..session.market.len()).filter(|j| *j != i) {
        let mut sale_svm = svm.clone();
        let vault_before = token_amount(&sale_svm, &session.market.vault(j)).unwrap_or(0);
        let leg = session.leg(&mut sale_svm, path, authority, i, j, amount);
        let received = leg.swap.as_ref().ok().map(|r| r.trader_received);
        let share = received.and_then(|r| share_ppm(r, vault_before));
        action.effect |= share.unwrap_or(0) > 0;
        action.sales.push(Sale {
            output: j,
            vault_before,
            received,
            share_of_vault_ppm: share,
            leg,
        });
    }
    action
}

/// The authority's instruction for `power` on the buyer's account of mint `i`.
fn instruction(
    session: &mut Session,
    svm: &mut LiteSVM,
    power: Power,
    authority: &Pubkey,
    i: usize,
    buyer: &Pubkey,
) -> (Instruction, Option<u64>) {
    let mint = session.market.mints[i].clone();
    let account = session.market.ata(buyer, i);
    match power {
        Power::FreezeAuthority => (
            token::freeze_account(&mint.token_program, &account, &mint.address, authority, &[])
                .expect("both token programs freeze"),
            None,
        ),
        Power::PauseAuthority => (
            pausable::instruction::pause(&mint.token_program, &mint.address, authority, &[])
                .expect("Token-2022 pauses"),
            None,
        ),
        Power::TransferFeeAuthority => (
            transfer_fee::instruction::set_transfer_fee(
                &mint.token_program,
                &mint.address,
                authority,
                &[],
                TRANSFER_FEE_ACTING_BPS,
                u64::MAX,
            )
            .expect("Token-2022 sets transfer fees"),
            None,
        ),
        Power::PermanentDelegate => {
            let held = token_amount(svm, &account).unwrap_or(0);
            let destination = session
                .seed
                .wallet(&session.market.address, "permanent delegate's own account");
            let to = write_token_account(svm, &mint.address, &mint.token_program, &destination, 0)
                .unwrap_or_default();
            let hooks = session.transfer_hook_accounts(
                svm,
                i,
                pipeline_check::hooks::Transfer {
                    source: account,
                    mint: mint.address,
                    destination: to,
                    authority: *authority,
                    amount: held,
                },
            );
            let mut ix = token::transfer_checked(
                &mint.token_program,
                &account,
                &mint.address,
                &to,
                authority,
                &[],
                held,
                mint.decimals,
            )
            .expect("both token programs take transfer_checked");
            ix.accounts.extend(hooks);
            (ix, Some(held))
        }
        Power::MintAuthority => unreachable!("the mint authority mints and sells instead"),
    }
}

fn act_in_round_trip(
    session: &mut Session,
    path: &dyn SwapPath,
    mut action: Action,
    authority: &Pubkey,
    money: usize,
    reference: u64,
) -> Action {
    let i = action.mint;
    let power = action.power;
    let Some(token) = (if i == money {
        (0..session.market.len()).find(|t| *t != money)
    } else {
        Some(i)
    }) else {
        return action.not_run("the market has no other mint to trade".to_string());
    };
    let moment = match (power, i == money) {
        (Power::TransferFeeAuthority, _) => Moment::BeforeBuy,
        (Power::PermanentDelegate, true) => Moment::AfterSale,
        _ => Moment::AfterBuy,
    };
    let mut svm = session.fresh();
    let buyer = session.funded_trader(
        &mut svm,
        &format!("{} of mint {i}", power.words()),
        money,
        reference,
    );
    let acted = |session: &mut Session, svm: &mut LiteSVM, action: &mut Action| -> bool {
        let (ix, moved) = instruction(session, svm, power, authority, i, &buyer);
        match act(svm, session, authority, ix) {
            Ok(()) => {
                action.moved = moved;
                if power == Power::TransferFeeAuthority {
                    move_epochs(svm, TRANSFER_FEE_EPOCHS_ON);
                }
                true
            }
            Err(failure) => {
                action.refused = Some(failure);
                false
            }
        }
    };
    // The same round trip without the authority acting, from the state it would act in, so
    // an outcome the market gives anyway is never laid at the authority's door.
    let mut baseline_from = matches!(moment, Moment::BeforeBuy).then(|| svm.clone());
    if matches!(moment, Moment::BeforeBuy) && !acted(session, &mut svm, &mut action) {
        let failure = action.refused.clone().expect("refused");
        return action.not_run(format!(
            "the authority's instruction was refused ({failure})"
        ));
    }
    let buy = session.leg(&mut svm, path, &buyer, money, token, reference);
    let bought = buy.swap.as_ref().ok().map_or(0, |r| r.trader_received);
    if buy.swap.is_err() && !matches!(moment, Moment::BeforeBuy) {
        let failure = buy
            .swap
            .as_ref()
            .err()
            .map_or_else(String::new, |f| f.to_string());
        return action.not_run(format!("the buy before acting failed ({failure})"));
    }
    if matches!(moment, Moment::AfterBuy) {
        baseline_from = Some(svm.clone());
        if !acted(session, &mut svm, &mut action) {
            let failure = action.refused.clone().expect("refused");
            return action.not_run(format!(
                "the authority's instruction was refused ({failure})"
            ));
        }
    }
    let sell = sell_all(session, &mut svm, path, &buyer, token, money, bought);
    let sold = sell
        .as_ref()
        .and_then(|leg| leg.swap.as_ref().ok())
        .map(|r| r.trader_received);
    if matches!(moment, Moment::AfterSale) {
        if sold.is_none() {
            return action.not_run(format!(
                "the round trip it would act after did not sell back{}",
                sell.as_ref()
                    .and_then(|leg| leg.swap.as_ref().err())
                    .map_or_else(String::new, |f| format!(" ({f})"))
            ));
        }
        if !acted(session, &mut svm, &mut action) {
            let failure = action.refused.clone().expect("refused");
            return action.not_run(format!(
                "the authority's instruction was refused ({failure})"
            ));
        }
    }
    let put_in = buy.swap.as_ref().ok().map(|r| r.trader_spent);
    action.return_ppm = put_in
        .zip(sold)
        .and_then(|(put_in, back)| share_ppm(back, put_in));
    let harmed = buy.swap.is_err()
        || bought == 0
        || sold.is_none()
        || action.moved.is_some_and(|m| m > 0)
        || action.return_ppm.is_none_or(|r| band(r) != Band::Pass);
    if harmed {
        if let Some(mut baseline) = baseline_from {
            let base_buy = match moment {
                Moment::BeforeBuy => {
                    Some(session.leg(&mut baseline, path, &buyer, money, token, reference))
                }
                _ => None,
            };
            let base_put_in = base_buy
                .as_ref()
                .map_or(put_in, |leg| leg.swap.as_ref().ok().map(|r| r.trader_spent));
            let base_bought = base_buy.as_ref().map_or(bought, |leg| {
                leg.swap.as_ref().ok().map_or(0, |r| r.trader_received)
            });
            let base_sold = sell_all(
                session,
                &mut baseline,
                path,
                &buyer,
                token,
                money,
                base_bought,
            )
            .and_then(|leg| leg.swap.ok())
            .map(|r| r.trader_received);
            let base_return = base_put_in
                .zip(base_sold)
                .and_then(|(p, b)| share_ppm(b, p));
            if base_return.is_none_or(|r| band(r) != Band::Pass) {
                return action.not_run(format!(
                    "without the authority acting, the same round trip {} too, so what acting did cannot be told apart",
                    match base_return {
                        Some(r) => format!("returns {}", crate::words::percent(r)),
                        None => "does not sell back".to_string(),
                    }
                ));
            }
        }
    }
    action.effect = harmed;
    action.round_trip = Some(RoundTrip {
        amount: reference,
        wallet: buyer,
        buy,
        sell,
    });
    action
}

/// Sells everything `bought` (with Pipeline's fee out of it) back into `money`; `None` when
/// nothing was bought.
fn sell_all(
    session: &mut Session,
    svm: &mut LiteSVM,
    path: &dyn SwapPath,
    buyer: &Pubkey,
    token: usize,
    money: usize,
    bought: u64,
) -> Option<Leg> {
    (bought > 0).then(|| {
        let amount = fees::amount_for_budget(bought, 0);
        session.leg(svm, path, buyer, token, money, amount)
    })
}

/// One sentence on what an action did.
fn effect_words(m: &Measured, a: &Action, money_words: &dyn Fn(u64) -> String) -> String {
    let mint = &m.mint_names[a.mint];
    let round_trip = a.round_trip.as_ref();
    let sale_failure = round_trip
        .and_then(|rt| rt.sale_failure())
        .map_or_else(String::new, |f| format!(" ({f})"));
    let after = format!("after a buy of {}", m.reference_words);
    match a.power {
        Power::MintAuthority => {
            let sales: Vec<String> = a
                .sales
                .iter()
                .map(
                    |s| match (s.share_of_vault_ppm, s.leg.swap.as_ref().err()) {
                        (Some(share), _) => format!(
                            "took {} of the vault of {}",
                            crate::words::share(share),
                            m.mint_names[s.output]
                        ),
                        (None, Some(f)) => {
                            format!("could not be sold into {} ({f})", m.mint_names[s.output])
                        }
                        (None, None) => {
                            format!("took nothing from the vault of {}", m.mint_names[s.output])
                        }
                    },
                )
                .collect();
            format!(
                "minting {MINT_AUTHORITY_MULTIPLE} times the vault's holding of {mint} as its mint authority and selling it {}",
                sales.join(" and ")
            )
        }
        Power::FreezeAuthority => format!(
            "freezing the buyer's account of {mint} {after} {}",
            sale_outcome(a, &sale_failure)
        ),
        Power::PauseAuthority => {
            format!("pausing {mint} {after} {}", sale_outcome(a, &sale_failure))
        }
        Power::PermanentDelegate => {
            let moved = a.moved.unwrap_or(0);
            if a.mint == m.money {
                format!(
                    "the permanent delegate of {mint} moved {} the sale returned away from the buyer",
                    money_words(moved)
                )
            } else {
                format!(
                    "the permanent delegate of {mint} moved all {} tokens the buyer held away {after}, and the sale {}",
                    crate::words::decimal(moved, m.decimals[a.mint]),
                    match round_trip.and_then(|rt| rt.sold()) {
                        Some(_) => "sold nothing of what was bought".to_string(),
                        None => format!("failed{sale_failure}"),
                    }
                )
            }
        }
        Power::TransferFeeAuthority => {
            let fee =
                crate::words::percent(TRANSFER_FEE_ACTING_BPS as u64 * (PPM / BPS_DENOMINATOR));
            let head = format!(
                "with the transfer fee of {mint} set to {fee} and the clock {TRANSFER_FEE_EPOCHS_ON} epochs on, a buy of {}",
                m.reference_words
            );
            match round_trip.map(|rt| (&rt.buy.swap, rt.sell.as_ref())) {
                Some((Err(f), _)) => format!("{head} failed ({f})"),
                Some((Ok(r), _)) if r.trader_received == 0 => format!(
                    "{head} took {} and delivered nothing",
                    money_words(r.trader_spent)
                ),
                _ => match a.return_ppm {
                    Some(r) => format!(
                        "{head} returned {} of what was put in",
                        crate::words::percent(r)
                    ),
                    None => format!("{head} could not be sold back{sale_failure}"),
                },
            }
        }
    }
}

fn sale_outcome(a: &Action, sale_failure: &str) -> String {
    match a.return_ppm {
        Some(r) => format!("left the sale returning {}", crate::words::percent(r)),
        None => format!("stopped the sale{sale_failure}"),
    }
}

/// Judges `token_authorities`. `money_words` says an amount of the money side.
pub fn judge(
    m: Option<&Measured>,
    trading: &Trading,
    money_words: &dyn Fn(u64) -> String,
) -> Verdict {
    let m = match (trading, m) {
        (Trading::NotRun(why), _) => return Verdict::not_run(format!("Not run: {why}.")),
        (Trading::Open, None) => {
            return Verdict::not_run("Not run: the market has no direction to trade.")
        }
        (Trading::Open, Some(m)) => m,
    };
    let inputs = json!({
        "mint_authority_multiple": MINT_AUTHORITY_MULTIPLE,
        "transfer_fee_bps": TRANSFER_FEE_ACTING_BPS,
        "transfer_fee_maximum": u64::MAX,
        "transfer_fee_epochs_on": TRANSFER_FEE_EPOCHS_ON,
        "reference": m.reference,
        "reference_words": m.reference_words,
        "money": m.money,
    });
    let numbers = json!({ "actions": m.actions });
    if m.actions.is_empty() {
        return Verdict::new(
            Outcome::Pass,
            "No mint has a mint, freeze, transfer-fee, permanent-delegate or pause authority.",
            inputs,
            numbers,
        );
    }
    let not_run: Vec<String> = m
        .actions
        .iter()
        .filter_map(|a| a.reason.as_ref().map(|r| r.to_string()))
        .collect();
    let not_run_words = if not_run.is_empty() {
        String::new()
    } else {
        format!(" Not run: {}.", not_run.join("; "))
    };
    let effects: Vec<String> = m
        .actions
        .iter()
        .filter(|a| a.outcome != "not run" && a.effect)
        .map(|a| effect_words(m, a, money_words))
        .collect();
    if !effects.is_empty() {
        let mut first = effects.join("; ");
        if let Some(c) = first.get(..1) {
            first = c.to_uppercase() + &first[1..];
        }
        return Verdict::new(
            Outcome::Warn,
            format!("{first}.{not_run_words}"),
            inputs,
            numbers,
        );
    }
    if m.actions.iter().all(|a| a.outcome == "not run") {
        return Verdict::new(
            Outcome::NotRun,
            format!("Not run: {}.", not_run.join("; ")),
            inputs,
            numbers,
        );
    }
    let acted: Vec<String> = m
        .actions
        .iter()
        .filter(|a| a.outcome != "not run")
        .map(|a| format!("mint {}'s {}", a.mint, a.power.words()))
        .collect();
    Verdict::new(
        Outcome::Pass,
        format!(
            "Acting as {} took nothing from the market and stopped no trade.{not_run_words}",
            acted.join(", ")
        ),
        inputs,
        numbers,
    )
}
