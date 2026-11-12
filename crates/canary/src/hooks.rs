//! Transfer-hook accounts for every trade (`docs/spec/pipescope-canary.md`, "How a run
//! works"), resolved as `pipeline-check` resolves them, with its own resolver: the input
//! mint's for the trader's transfer into the vault, passed as the router's
//! `input_hook_accounts`, and the output mint's for the strategy's transfer out of its vault,
//! passed after the strategy's own accounts. An account a hook names that the copy lacks is
//! read from the source like any other; hooks that cannot be resolved get no accounts, so
//! the swap fails and says why.

use litesvm::LiteSVM;
use pipeline_check::hooks::{self, Transfer};
use pipeline_client::{AccountMeta, Pubkey};

use crate::market::Session;

/// A trade's transfer-hook accounts.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct HookAccounts {
    /// For the input mint's transfer from the trader to the vault (and the router's fee
    /// transfers, which go from the same account).
    pub input: Vec<AccountMeta>,
    /// For the output mint's transfer from the vault to the trader.
    pub output: Vec<AccountMeta>,
}

/// A token account's owner, if the account holds one.
pub fn token_owner(svm: &LiteSVM, account: &Pubkey) -> Option<Pubkey> {
    const OWNER: std::ops::Range<usize> = 32..64;
    svm.get_account(account).and_then(|a| {
        a.data
            .get(OWNER)
            .map(|b| Pubkey::new_from_array(b.try_into().expect("32 bytes")))
    })
}

/// How many times a hook's accounts are resolved, loading what the last round named, so
/// entries that read an earlier account's data see it (as `pipeline-check`'s cloner does).
const RESOLVE_ROUNDS: usize = 3;

impl Session<'_> {
    /// The hook accounts for one transfer of `mint`'s, when it has a hook.
    fn transfer_hook_accounts(
        &mut self,
        svm: &mut LiteSVM,
        mint: usize,
        transfer: Transfer,
    ) -> Vec<AccountMeta> {
        let Some(program) = self.market.mints[mint].transfer_hook_program() else {
            return vec![];
        };
        let mut last = Err(String::new());
        for _ in 0..RESOLVE_ROUNDS {
            last = hooks::resolve(&program, &transfer, |key| {
                svm.get_account(key).map(|a| a.data)
            });
            let keys: Vec<Pubkey> = match &last {
                Ok(metas) => metas.iter().map(|m| m.pubkey).collect(),
                // The list itself may be what the copy lacks.
                Err(_) => vec![program, hooks::validation_address(&program, &transfer.mint)],
            };
            let before = keys.iter().filter(|k| svm.get_account(k).is_some()).count();
            self.load(svm, &keys);
            let after = keys.iter().filter(|k| svm.get_account(k).is_some()).count();
            if after == before {
                break;
            }
        }
        match last {
            Ok(metas) => metas,
            Err(error) => {
                let note = format!(
                    "the transfer hook {program} of mint {} could not be resolved: {error}",
                    transfer.mint
                );
                if !self.notes.contains(&note) {
                    self.notes.push(note);
                }
                vec![]
            }
        }
    }

    /// The hook accounts of a trade by `trader` sending `amount_in` of `input` for about
    /// `expected_out` of `output` (hooks may derive accounts from the amount).
    pub fn hook_accounts(
        &mut self,
        svm: &mut LiteSVM,
        trader: &Pubkey,
        input: usize,
        output: usize,
        amount_in: u64,
        expected_out: u64,
    ) -> HookAccounts {
        let market = self.market.clone();
        let input_transfer = Transfer {
            source: market.ata(trader, input),
            mint: market.mint(input),
            destination: market.vault(input),
            authority: *trader,
            amount: amount_in,
        };
        let vault = market.vault(output);
        let output_transfer = Transfer {
            source: vault,
            mint: market.mint(output),
            destination: market.ata(trader, output),
            authority: token_owner(svm, &vault).unwrap_or_default(),
            amount: expected_out,
        };
        HookAccounts {
            input: self.transfer_hook_accounts(svm, input, input_transfer),
            output: self.transfer_hook_accounts(svm, output, output_transfer),
        }
    }
}
