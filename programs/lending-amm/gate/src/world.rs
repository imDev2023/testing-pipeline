//! A LiteSVM holding a snapshot: every saved account, the router, Kamino Lend and a build of
//! the program, at the cluster's clock when the snapshot was taken, one slot on.

use lending_amm::config::LENT_MINTS;
use litesvm::LiteSVM;
use pipeline_client::{self as client, pda, Pubkey};
use solana_account::Account;

use crate::kamino::{self, key};
use crate::snapshot::{Snapshot, LOADER_V3};

/// The programs a replay runs besides the strategy: the router and klend, each from its bytes
/// when given, else as the snapshot copied it from its cluster.
#[derive(Clone, Copy, Default)]
pub struct Programs<'a> {
    pub router: Option<&'a [u8]>,
    pub klend: Option<&'a [u8]>,
}

/// Loads `snapshot` with `strategy_elf` as the program.
pub fn load(
    snapshot: &Snapshot,
    strategy_elf: &[u8],
    programs: Programs,
) -> Result<LiteSVM, String> {
    let program = snapshot.program_id()?;
    let mut svm = clocked(snapshot);
    let replaced = loaded_programs(&program);
    let mut executables: Vec<(Pubkey, Account)> = vec![];
    for (address, account) in snapshot.accounts()? {
        if replaced.contains(&address) {
            continue;
        }
        // Other programs (a transfer hook's, say) go in after every ProgramData.
        if account.executable {
            executables.push((address, account));
        } else {
            install(&mut svm, address, account)?;
        }
    }
    for (address, account) in executables {
        install(&mut svm, address, account)?;
    }
    add_programs(&mut svm, snapshot, program, strategy_elf, programs)?;
    Ok(svm)
}

/// The world of the market the gate makes of its own: the router and klend the replay runs,
/// `strategy_elf` at the program's address, and of the cluster's accounts only the Kamino
/// accounts of each lent mint, with Kamino's stops cleared and a second depositor's liquidity
/// in each reserve (`kamino::clear_stops`, `kamino::second_depositor`), at the snapshot's
/// clock; so nothing else on the cluster, and no state Kamino's owner or a borrower put the
/// reserve in, can refuse every candidate there.
pub fn own(
    snapshot: &Snapshot,
    strategy_elf: &[u8],
    programs: Programs,
) -> Result<LiteSVM, String> {
    let program = snapshot.program_id()?;
    let mut svm = clocked(snapshot);
    let saved = snapshot.accounts()?;
    let find = |address: &Pubkey| {
        saved
            .iter()
            .find(|(a, _)| a == address)
            .map(|(_, account)| account.clone())
    };
    for entry in &LENT_MINTS {
        let Some(reserve) = find(&key(&entry.reserve)) else {
            continue;
        };
        let accounts = kamino::Accounts::of(entry, &reserve.data)
            .ok_or("a lent mint's reserve is too short")?;
        for address in accounts.addresses() {
            if let Some(account) = find(&address) {
                install(&mut svm, address, account)?;
            }
        }
    }
    add_programs(&mut svm, snapshot, program, strategy_elf, programs)?;
    kamino::clear_stops(&mut svm);
    kamino::second_depositor(&mut svm)?;
    Ok(svm)
}

/// The program, the router and klend, and their ProgramData: loaded from their bytes, never
/// from the saved accounts.
fn loaded_programs(program: &Pubkey) -> [Pubkey; 6] {
    [
        *program,
        pda::program_data(program),
        client::PROGRAM_ID,
        pda::program_data(&client::PROGRAM_ID),
        kamino::klend(),
        pda::program_data(&kamino::klend()),
    ]
}

fn add_programs(
    svm: &mut LiteSVM,
    snapshot: &Snapshot,
    program: Pubkey,
    strategy_elf: &[u8],
    programs: Programs,
) -> Result<(), String> {
    let router = match programs.router {
        Some(elf) => elf.to_vec(),
        None => snapshot
            .program_elf(&client::PROGRAM_ID)?
            .ok_or("the snapshot holds no router; pass the pinned router")?,
    };
    svm.add_program(client::PROGRAM_ID, &router)
        .map_err(|e| format!("the router does not load: {e}"))?;
    let klend = match programs.klend {
        Some(elf) => Some(elf.to_vec()),
        None => snapshot.program_elf(&kamino::klend())?,
    };
    if let Some(klend) = klend {
        svm.add_program(kamino::klend(), &klend)
            .map_err(|e| format!("Kamino Lend does not load: {e}"))?;
    }
    load_program(svm, program, strategy_elf)
}

/// Replaces the program's executable with `elf`, as an upgrade would.
pub fn load_program(svm: &mut LiteSVM, program: Pubkey, elf: &[u8]) -> Result<(), String> {
    svm.add_program(program, elf)
        .map_err(|e| format!("the build does not load: {e}"))
}

fn install(svm: &mut LiteSVM, address: Pubkey, account: Account) -> Result<(), String> {
    // A program LiteSVM ships (the token programs, say) stays LiteSVM's own.
    if account.executable && account.owner != LOADER_V3 && svm.get_account(&address).is_some() {
        return Ok(());
    }
    svm.set_account(address, account)
        .map_err(|e| format!("account {address} does not load: {e}"))
}

/// A VM at the cluster's clock, one slot on, as a transaction sent after the snapshot would
/// run; the time stays the snapshot's. Signatures are not checked, as in the buy wall AMM's
/// gate, though every step here signs with keys the gate holds.
fn clocked(snapshot: &Snapshot) -> LiteSVM {
    let mut svm = LiteSVM::new().with_sigverify(false);
    let cluster = &snapshot.cluster;
    if cluster.slot > 0 {
        svm.warp_to_slot(cluster.slot + 1);
    }
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.epoch = cluster.epoch;
    clock.leader_schedule_epoch = cluster.epoch + 1;
    clock.unix_timestamp = cluster.unix_timestamp;
    clock.epoch_start_timestamp = cluster.unix_timestamp;
    svm.set_sysvar(&clock);
    svm
}
