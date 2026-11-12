//! Test only, never deployed to devnet: a stand-in for a launchpad graduating a token into a
//! Pipeline strategy (Pipeline's strategy guide, section 9).
//!
//! A creator's launch has a seeder, the PDA `["seeder", creator]`, which owns the launch's
//! escrows (any token accounts it owns). `graduate` calls a strategy's
//! `pipeline_seed_liquidity` with the seeder signing, and with a payer of its own, the PDA
//! `["payer", seeder]`, funded with at most `max_payer_lamports` and emptied back to the
//! creator afterwards. It checks what a careful launchpad checks: the strategy took at most
//! `amounts[i]` from each escrow (measured, not trusted from its return data), spent at most
//! `max_payer_lamports` of the payer, whatever it held before, and left the payer a plain
//! system account. It sets its own return data to [`Graduation`]: the
//! strategy's `SeedResult` beside what actually left each escrow.
//!
//! The caller records the market with the router's `register_existing_market` and
//! `init_fee_account` in the same transaction, after `graduate`: a program can't record a
//! market through a CPI to the router, because the router calls back into the strategy.
//!
//! `call_as_seeder` calls any instruction with the seeder signing, so tests can show what a
//! strategy does with the seeder's signature after graduation.
//!
//! Every strategy's seeding tests share it (the tax AMM's, the buy wall AMM's and the
//! lending AMM's). `scripts/build-programs.sh` builds it into `fixtures/test-programs`, and
//! nothing deploys it anywhere but a local validator or LiteSVM.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::{get_return_data, invoke_signed, set_return_data};
use anchor_lang::system_program;
use pipeline_strategy_interface as psi;

declare_id!("StandinLaunchpad111111111111111111111111111");

/// Seeds of a launch's seeder, `["seeder", creator]`.
pub const SEEDER_SEED: &[u8] = b"seeder";
/// Seeds of a seeder's payer, `["payer", seeder]`.
pub const PAYER_SEED: &[u8] = b"payer";

/// A launch's seeder, the PDA that owns its escrows and signs its graduation.
pub fn seeder_address(creator: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[SEEDER_SEED, creator.as_ref()], &ID).0
}

/// The payer a seeder's graduation lends to the strategy.
pub fn payer_address(seeder: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[PAYER_SEED, seeder.as_ref()], &ID).0
}

/// `graduate`'s return data.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct Graduation {
    /// The strategy's `SeedResult.taken`.
    pub taken: Vec<u64>,
    /// The strategy's `SeedResult.lp_amount`.
    pub lp_amount: u64,
    /// What left each escrow during the call, measured.
    pub left_escrows: Vec<u64>,
}

#[program]
pub mod stand_in_launchpad {
    use super::*;

    /// Graduates the creator's launch into `strategy_program`. Remaining accounts are the
    /// strategy's `pipeline_seed_liquidity` accounts after the seeder, the payer and the
    /// system program: the market state, the LP recipient, then mint, escrow and token
    /// program for each mint, then the strategy's own accounts and any transfer-hook
    /// accounts.
    pub fn graduate<'info>(
        ctx: Context<'info, Graduate<'info>>,
        amounts: Vec<u64>,
        data: Vec<u8>,
        max_payer_lamports: u64,
    ) -> Result<()> {
        let rest = ctx.remaining_accounts;
        let mints = amounts.len();
        require!(rest.len() >= 2 + 3 * mints, LaunchpadError::MissingAccounts);
        let escrows: Vec<&AccountInfo> = (0..mints).map(|i| &rest[3 + 3 * i]).collect();
        let before = escrows
            .iter()
            .map(|escrow| token_balance(escrow))
            .collect::<Result<Vec<u64>>>()?;

        let accounts = &ctx.accounts;
        // Lamports anyone sent to the payer beforehand stay out of what the strategy may spend.
        let payer_before = accounts.payer.lamports();
        system_program::transfer(
            CpiContext::new(
                accounts.system_program.key(),
                system_program::Transfer {
                    from: accounts.creator.to_account_info(),
                    to: accounts.payer.to_account_info(),
                },
            ),
            max_payer_lamports,
        )?;

        let mut metas = vec![
            AccountMeta::new_readonly(accounts.seeder.key(), true),
            meta(&rest[0]),
            AccountMeta::new(accounts.payer.key(), true),
            AccountMeta::new_readonly(system_program::ID, false),
            meta(&rest[1]),
        ];
        metas.extend(rest[2..].iter().map(meta));
        let mut infos = vec![
            accounts.seeder.to_account_info(),
            rest[0].clone(),
            accounts.payer.to_account_info(),
            accounts.system_program.to_account_info(),
            rest[1].clone(),
        ];
        infos.extend(rest[2..].iter().cloned());
        infos.push(accounts.strategy_program.to_account_info());
        let mut call = psi::discriminator::SEED_LIQUIDITY.to_vec();
        psi::SeedRequest {
            amounts: amounts.clone(),
            data,
        }
        .serialize(&mut call)?;
        let strategy = accounts.strategy_program.key();
        let creator = accounts.creator.key();
        let seeder = accounts.seeder.key();
        let seeder_seeds: &[&[u8]] = &[SEEDER_SEED, creator.as_ref(), &[ctx.bumps.seeder]];
        let payer_seeds: &[&[u8]] = &[PAYER_SEED, seeder.as_ref(), &[ctx.bumps.payer]];
        invoke_signed(
            &Instruction {
                program_id: strategy,
                accounts: metas,
                data: call,
            },
            &infos,
            &[seeder_seeds, payer_seeds],
        )?;

        let (program, returned) = get_return_data().ok_or(LaunchpadError::NoSeedResult)?;
        require_keys_eq!(program, strategy, LaunchpadError::NoSeedResult);
        let result = psi::SeedResult::try_from_slice(&returned)
            .map_err(|_| error!(LaunchpadError::NoSeedResult))?;
        let mut left_escrows = Vec::with_capacity(mints);
        for (i, escrow) in escrows.iter().enumerate() {
            let left = before[i]
                .checked_sub(token_balance(escrow)?)
                .ok_or(LaunchpadError::EscrowGrew)?;
            require!(left <= amounts[i], LaunchpadError::TookTooMuch);
            left_escrows.push(left);
        }

        // The payer must still be a plain system account, which the strategy only paid from.
        let payer = &ctx.accounts.payer;
        require!(
            payer.owner == &system_program::ID && payer.data_is_empty(),
            LaunchpadError::PayerTampered
        );
        let unspent = payer.lamports();
        require!(unspent >= payer_before, LaunchpadError::PayerOverspent);
        let rent = payer_before + max_payer_lamports - unspent;
        if unspent > 0 {
            system_program::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.key(),
                    system_program::Transfer {
                        from: payer.to_account_info(),
                        to: ctx.accounts.creator.to_account_info(),
                    },
                    &[payer_seeds],
                ),
                unspent,
            )?;
        }

        msg!(
            "Graduated into {}: taken {:?}, left the escrows {:?}, rent {} lamports",
            strategy,
            result.taken,
            left_escrows,
            rent
        );
        let graduation = Graduation {
            taken: result.taken,
            lp_amount: result.lp_amount,
            left_escrows,
        };
        let mut encoded = vec![];
        graduation.serialize(&mut encoded)?;
        set_return_data(&encoded);
        Ok(())
    }

    /// Calls `program` with `data`, the remaining accounts as its accounts, and the
    /// creator's seeder signing wherever it appears among them.
    pub fn call_as_seeder<'info>(
        ctx: Context<'info, CallAsSeeder<'info>>,
        data: Vec<u8>,
    ) -> Result<()> {
        let seeder = ctx.accounts.seeder.key();
        let metas = ctx
            .remaining_accounts
            .iter()
            .map(|account| AccountMeta {
                pubkey: account.key(),
                is_signer: account.key() == seeder,
                is_writable: account.is_writable,
            })
            .collect();
        let mut infos = ctx.remaining_accounts.to_vec();
        infos.push(ctx.accounts.seeder.to_account_info());
        infos.push(ctx.accounts.program.to_account_info());
        let creator = ctx.accounts.creator.key();
        invoke_signed(
            &Instruction {
                program_id: ctx.accounts.program.key(),
                accounts: metas,
                data,
            },
            &infos,
            &[&[SEEDER_SEED, creator.as_ref(), &[ctx.bumps.seeder]]],
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    /// Owns the launch, and lends the payer its SOL.
    #[account(mut)]
    pub creator: Signer<'info>,
    /// CHECK: the launch's seeder PDA; it holds no data.
    #[account(seeds = [SEEDER_SEED, creator.key().as_ref()], bump)]
    pub seeder: UncheckedAccount<'info>,
    /// CHECK: the seeder's payer PDA, a system account while it holds SOL.
    #[account(mut, seeds = [PAYER_SEED, seeder.key().as_ref()], bump)]
    pub payer: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the strategy to graduate into; any program.
    pub strategy_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CallAsSeeder<'info> {
    pub creator: Signer<'info>,
    /// CHECK: the launch's seeder PDA.
    #[account(seeds = [SEEDER_SEED, creator.key().as_ref()], bump)]
    pub seeder: UncheckedAccount<'info>,
    /// CHECK: the program to call; any program.
    pub program: UncheckedAccount<'info>,
}

#[error_code]
pub enum LaunchpadError {
    #[msg("Fewer accounts than the seed request's mints need")]
    MissingAccounts,
    #[msg("The strategy returned no SeedResult")]
    NoSeedResult,
    #[msg("An escrow grew during the graduation")]
    EscrowGrew,
    #[msg("The strategy took more than the amount allowed from an escrow")]
    TookTooMuch,
    #[msg("The strategy left the payer something other than a plain system account")]
    PayerTampered,
    #[msg("An escrow is not a token account")]
    NotATokenAccount,
    #[msg("The strategy spent more of the payer than the graduation lent it")]
    PayerOverspent,
}

fn meta(account: &AccountInfo) -> AccountMeta {
    AccountMeta {
        pubkey: account.key(),
        is_signer: false,
        is_writable: account.is_writable,
    }
}

/// The amount field of an SPL Token or Token-2022 account.
fn token_balance(account: &AccountInfo) -> Result<u64> {
    let data = account.try_borrow_data()?;
    let amount: [u8; 8] = data
        .get(64..72)
        .and_then(|bytes| bytes.try_into().ok())
        .ok_or(LaunchpadError::NotATokenAccount)?;
    Ok(u64::from_le_bytes(amount))
}
