//! A LiteSVM holding a snapshot: every saved account, the router and a build of the
//! program, at the cluster's clock when the snapshot was taken.

use litesvm::LiteSVM;
use pipeline_client::{self as client, pda, Pubkey};
use solana_account::Account;

use crate::snapshot::{Snapshot, LOADER_V3};

/// Loads `snapshot` with `strategy_elf` as the program. The router is `router_elf` when
/// given, else the router the snapshot copied from its cluster.
pub fn load(
    snapshot: &Snapshot,
    strategy_elf: &[u8],
    router_elf: Option<&[u8]>,
) -> Result<LiteSVM, String> {
    let program = snapshot.program_id()?;
    // The replay checks no signatures, so the gate can act as a market's seeder; the programs
    // still see who the message says signed, which is what they check.
    let mut svm = LiteSVM::new().with_sigverify(false);
    set_clock(&mut svm, snapshot);

    let router = match router_elf {
        Some(elf) => elf.to_vec(),
        None => snapshot
            .program_elf(&client::PROGRAM_ID)?
            .ok_or("the snapshot holds no router; pass the pinned router")?,
    };
    // The two programs are loaded from their bytes, never from the saved accounts.
    let replaced = [
        program,
        pda::program_data(&program),
        client::PROGRAM_ID,
        pda::program_data(&client::PROGRAM_ID),
    ];
    let mut programs: Vec<(Pubkey, Account)> = vec![];
    for (address, account) in snapshot.accounts()? {
        if replaced.contains(&address) {
            continue;
        }
        // Other programs (a transfer hook's, say) go in after every ProgramData.
        if account.executable {
            programs.push((address, account));
        } else {
            install(&mut svm, address, account)?;
        }
    }
    for (address, account) in programs {
        install(&mut svm, address, account)?;
    }
    svm.add_program(client::PROGRAM_ID, &router)
        .map_err(|e| format!("the router does not load: {e}"))?;
    load_program(&mut svm, program, strategy_elf)?;
    Ok(svm)
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

fn set_clock(svm: &mut LiteSVM, snapshot: &Snapshot) {
    let cluster = &snapshot.cluster;
    if cluster.slot > 0 {
        svm.warp_to_slot(cluster.slot);
    }
    let mut clock: solana_clock::Clock = svm.get_sysvar();
    clock.epoch = cluster.epoch;
    clock.leader_schedule_epoch = cluster.epoch + 1;
    clock.unix_timestamp = cluster.unix_timestamp;
    clock.epoch_start_timestamp = cluster.unix_timestamp;
    svm.set_sysvar(&clock);
}
