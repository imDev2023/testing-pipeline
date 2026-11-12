//! The copy of one market in a local Solana VM, and the session that trades in it.
//!
//! The copy is `pipeline-check`'s own cloner over the caller's [`Source`], with the router
//! and the strategy as the cluster's own bytes. Signature checks are off, so a run can act
//! as any key, and each scenario starts from a fresh clone of the copy. Accounts a later
//! trade names that the copy lacks are read from the same source; when the source does not
//! hold them (a snapshot), the session notes which measurement needed them.

use std::collections::{BTreeSet, HashMap, HashSet};

use litesvm::LiteSVM;
use pipeline_check::{
    clone::cluster_name, clone_market, executable_sha256, CheckOptions, ClusterInfo,
};
use pipeline_client::{self as client, pda, pubkey, Pubkey};
use pipeline_quoter::MarketView;
use serde::Serialize;
use solana_account::Account;
use spl_token_2022_interface::extension::transfer_fee::TransferFeeConfig;
use spl_token_2022_interface::extension::{BaseStateWithExtensions, StateWithExtensions};
use spl_token_2022_interface::state::Mint;

use crate::source::Source;

/// The classic wrapped SOL mint, and Token-2022's.
pub const WRAPPED_SOL: [Pubkey; 2] = [
    pubkey!("So11111111111111111111111111111111111111112"),
    pubkey!("9pan9bMn5HatX4EJdBwg9VgCa7Uz5HL8N1m5D3NdXejP"),
];

const SYSVAR_OWNER: Pubkey = pubkey!("Sysvar1111111111111111111111111111111111111");
const NATIVE_LOADER: Pubkey = pubkey!("NativeLoader1111111111111111111111111111111");
/// ProgramData's header: a 4-byte tag, the deploy slot, then an optional upgrade authority.
const PROGRAM_DATA_HEADER_LEN: usize = 45;
const PROGRAM_DATA_SLOT: std::ops::Range<usize> = 4..12;
/// SPL token account and mint layouts (the same base in Token-2022).
const TOKEN_AMOUNT: std::ops::Range<usize> = 64..72;
const MINT_SUPPLY: std::ops::Range<usize> = 36..44;
const MINT_DECIMALS: usize = 44;

/// A program version: its ProgramData deploy slot and executable hash.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct Version {
    pub deploy_slot: Option<u64>,
    /// `pipeline-check`'s `executable_sha256`.
    pub executable_sha256: Option<String>,
}

impl Version {
    pub fn of(svm: &LiteSVM, program: &Pubkey) -> Self {
        let upgradeable = svm
            .get_account(program)
            .is_some_and(|a| a.owner == client::BPF_LOADER_UPGRADEABLE_ID);
        Version {
            deploy_slot: upgradeable
                .then(|| svm.get_account(&pda::program_data(program)))
                .flatten()
                .and_then(|a| {
                    a.data
                        .get(PROGRAM_DATA_SLOT)
                        .map(|b| u64::from_le_bytes(b.try_into().expect("8 bytes")))
                }),
            executable_sha256: program_elf(svm, program).map(|elf| executable_sha256(&elf).0),
        }
    }
}

/// A program's executable bytes as the VM holds them: for the upgradeable loader, its
/// ProgramData after the header; otherwise the program account's own data.
pub fn program_elf(svm: &LiteSVM, program: &Pubkey) -> Option<Vec<u8>> {
    let account = svm.get_account(program)?;
    if account.owner == client::BPF_LOADER_UPGRADEABLE_ID {
        let data = svm.get_account(&pda::program_data(program))?.data;
        return data.get(PROGRAM_DATA_HEADER_LEN..).map(|d| d.to_vec());
    }
    Some(account.data)
}

/// What a run needs to know about one of the market's mints.
#[derive(Clone, Debug)]
pub struct MintFacts {
    pub address: Pubkey,
    pub token_program: Pubkey,
    pub decimals: u8,
    pub supply: u64,
    pub transfer_fee: Option<TransferFeeConfig>,
}

impl MintFacts {
    fn read(address: Pubkey, account: &Account) -> Result<Self, String> {
        let data = &account.data;
        if data.len() <= MINT_DECIMALS {
            return Err(format!("mint {address} is too short to be a mint"));
        }
        let transfer_fee = if account.owner == client::TOKEN_2022_PROGRAM_ID {
            StateWithExtensions::<Mint>::unpack(data)
                .map_err(|e| format!("mint {address} does not unpack: {e}"))?
                .get_extension::<TransferFeeConfig>()
                .ok()
                .copied()
        } else {
            None
        };
        Ok(MintFacts {
            address,
            token_program: account.owner,
            decimals: data[MINT_DECIMALS],
            supply: u64::from_le_bytes(data[MINT_SUPPLY].try_into().expect("8 bytes")),
            transfer_fee,
        })
    }

    pub fn is_wrapped_sol(&self) -> bool {
        WRAPPED_SOL.contains(&self.address)
    }

    /// The Token-2022 transfer fee on moving `amount` in `epoch`.
    pub fn transfer_fee_on(&self, epoch: u64, amount: u64) -> u64 {
        self.transfer_fee
            .and_then(|config| config.calculate_epoch_fee(epoch, amount))
            .unwrap_or(0)
    }
}

/// A token account's balance, if the account holds one.
pub fn token_amount(svm: &LiteSVM, account: &Pubkey) -> Option<u64> {
    svm.get_account(account).and_then(|a| {
        a.data
            .get(TOKEN_AMOUNT)
            .map(|b| u64::from_le_bytes(b.try_into().expect("8 bytes")))
    })
}

/// The copied market's fixed facts.
#[derive(Clone, Debug)]
pub struct Market {
    pub address: Pubkey,
    pub record: client::Market,
    pub view: MarketView,
    pub mints: Vec<MintFacts>,
}

impl Market {
    pub fn len(&self) -> usize {
        self.record.mint_count as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn strategy(&self) -> Pubkey {
        self.record.strategy_program
    }

    pub fn mint(&self, i: usize) -> Pubkey {
        self.mints[i].address
    }

    pub fn token_program(&self, i: usize) -> Pubkey {
        self.mints[i].token_program
    }

    pub fn vault(&self, i: usize) -> Pubkey {
        self.record.vaults[i]
    }

    pub fn ata(&self, owner: &Pubkey, i: usize) -> Pubkey {
        pda::associated_token(owner, &self.mint(i), &self.token_program(i))
    }
}

/// The copy, before any trade.
pub struct Copy {
    pub cluster: ClusterInfo,
    /// The VM exactly as the cloner built it, for `pipeline-check`.
    pub pristine: LiteSVM,
    pub market: Market,
    pub strategy_version: Version,
    pub router_version: Version,
    pub notes: Vec<String>,
}

impl Copy {
    /// Where the copy's state came from, as `pipeline-check`'s report describes it.
    pub fn report_source(&self) -> pipeline_check::Source {
        pipeline_check::Source {
            kind: "rpc".into(),
            cluster: self
                .cluster
                .genesis_hash
                .as_deref()
                .and_then(cluster_name)
                .map(str::to_string),
            genesis_hash: self.cluster.genesis_hash.clone(),
            slot: self.cluster.slot,
            unix_timestamp: self.cluster.unix_timestamp,
        }
    }

    /// Copies `market` from `source`. `options` decides which trades' accounts the cloner
    /// resolves up front; later trades read any others from the source.
    pub fn build(
        source: &mut dyn Source,
        market: Pubkey,
        options: &CheckOptions,
    ) -> Result<Self, String> {
        let cloned = clone_market(source, market, None, options)?;
        let svm = cloned.svm;
        let record = svm
            .get_account(&market)
            .and_then(|a| client::decode_market(&a.data))
            .ok_or_else(|| format!("{market} is not a Pipeline Market account"))?;
        let mut mints = vec![];
        for address in record.mints() {
            let account = svm
                .get_account(address)
                .ok_or_else(|| format!("mint {address} does not exist"))?;
            mints.push(MintFacts::read(*address, &account)?);
        }
        let view = MarketView::from_market(
            market,
            &record,
            mints.iter().map(|m| m.token_program).collect(),
        )
        .map_err(|e| format!("cannot describe the market: {e}"))?;
        Ok(Copy {
            cluster: cloned.cluster,
            strategy_version: Version::of(&svm, &record.strategy_program),
            router_version: Version::of(&svm, &client::PROGRAM_ID),
            market: Market {
                address: market,
                record,
                view,
                mints,
            },
            pristine: svm,
            notes: cloned.notes,
        })
    }
}

/// A run's state on one market: the copy ready to trade, and the source behind it.
pub struct Session<'a> {
    pub market: Market,
    base: LiteSVM,
    source: &'a mut dyn Source,
    /// Accounts read after the copy, so each is read once.
    cache: HashMap<Pubkey, Option<Account>>,
    /// Addresses the source lacks.
    lacking: HashSet<Pubkey>,
    /// Lacking addresses the current measurement asked for.
    touched: BTreeSet<Pubkey>,
    /// Pays for the run's own read-only calls.
    pub payer: Pubkey,
    /// `TradeRequest::extra` on every quote and swap.
    pub extra: Vec<u8>,
    /// The run's seed, from which every wallet comes.
    pub seed: crate::wallets::Seed,
    pub notes: Vec<String>,
}

impl<'a> Session<'a> {
    /// Turns the copy into a VM a trader can use: signature checks off and no transaction
    /// history, so any key can act and repeated trades are not refused as duplicates; and
    /// each mint's fee account created where it does not exist yet, as anyone may.
    pub fn new(
        copy: &Copy,
        source: &'a mut dyn Source,
        extra: Vec<u8>,
        seed: crate::wallets::Seed,
    ) -> Self {
        let mut base = copy
            .pristine
            .clone()
            .with_sigverify(false)
            .with_blockhash_check(false)
            .with_transaction_history(0);
        let payer = Pubkey::new_unique();
        fund_lamports(&mut base, &payer);
        let market = copy.market.clone();
        let mut notes = vec![];
        for i in 0..market.len() {
            let fee_account =
                pda::fee_account(&market.address, &market.mint(i), &market.token_program(i));
            if base.get_account(&fee_account).is_some() {
                continue;
            }
            let ix = client::init_fee_account(
                &payer,
                &market.address,
                &market.mint(i),
                &market.token_program(i),
            );
            let mut tx = solana_transaction::Transaction::new_with_payer(&[ix], Some(&payer));
            tx.message.recent_blockhash = base.latest_blockhash();
            match base.send_transaction(tx) {
                Ok(_) => notes.push(format!(
                    "created the missing fee account for mint {} in the copy",
                    market.mint(i)
                )),
                Err(failed) => notes.push(format!(
                    "could not create the missing fee account for mint {}: {:?}",
                    market.mint(i),
                    failed.err
                )),
            }
        }
        Session {
            market,
            base,
            cache: HashMap::new(),
            lacking: source.missing().into_iter().collect(),
            source,
            touched: BTreeSet::new(),
            payer,
            extra,
            seed,
            notes,
        }
    }

    /// A fresh copy for one scenario.
    pub fn fresh(&self) -> LiteSVM {
        self.base.clone()
    }

    /// The copy as it stands, for read-only probes.
    pub fn base(&self) -> &LiteSVM {
        &self.base
    }

    /// Every address the source has been asked for and lacks, in the order first asked.
    pub fn source_missing(&self) -> Vec<Pubkey> {
        self.source.missing()
    }

    /// Starts a measurement: forgets which lacking addresses were asked for.
    pub fn begin_measurement(&mut self) {
        self.touched.clear();
    }

    /// The lacking addresses the measurement since [`Session::begin_measurement`] asked for.
    pub fn lacking_since_begin(&self) -> BTreeSet<Pubkey> {
        self.touched.clone()
    }

    /// Loads the accounts at `keys` that `svm` does not hold, reading each from the source
    /// once. Programs come with their ProgramData. Accounts also go into the base copy, so
    /// later scenarios start with them.
    pub fn load(&mut self, svm: &mut LiteSVM, keys: &[Pubkey]) {
        let wanted: Vec<Pubkey> = keys
            .iter()
            .filter(|k| svm.get_account(k).is_none())
            .copied()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        let unread: Vec<Pubkey> = wanted
            .iter()
            .filter(|k| !self.cache.contains_key(*k))
            .copied()
            .collect();
        if !unread.is_empty() {
            self.read(&unread);
        }
        let program_data: Vec<Pubkey> = wanted
            .iter()
            .filter_map(|k| self.cache.get(k).cloned().flatten().map(|a| (*k, a)))
            .filter(|(_, a)| a.executable && a.owner == client::BPF_LOADER_UPGRADEABLE_ID)
            .map(|(k, _)| pda::program_data(&k))
            .filter(|k| !self.cache.contains_key(k))
            .collect();
        if !program_data.is_empty() {
            self.read(&program_data);
        }
        for key in wanted {
            if self.lacking.contains(&key) {
                self.touched.insert(key);
            }
            let Some(account) = self.cache.get(&key).cloned().flatten() else {
                continue;
            };
            if account.owner == SYSVAR_OWNER || account.owner == NATIVE_LOADER {
                continue;
            }
            if account.executable && account.owner == client::BPF_LOADER_UPGRADEABLE_ID {
                let data_key = pda::program_data(&key);
                if self.lacking.contains(&data_key) {
                    self.touched.insert(data_key);
                }
                if let Some(data) = self.cache.get(&data_key).cloned().flatten() {
                    install(svm, &mut self.base, data_key, data, &mut self.notes);
                }
            }
            install(svm, &mut self.base, key, account, &mut self.notes);
        }
    }

    fn read(&mut self, keys: &[Pubkey]) {
        let before: HashSet<Pubkey> = self.source.missing().into_iter().collect();
        match self.source.get_accounts(keys) {
            Ok(accounts) => {
                for (key, account) in keys.iter().zip(accounts) {
                    self.cache.insert(*key, account);
                }
            }
            Err(error) => {
                self.notes
                    .push(format!("reading {} accounts failed: {error}", keys.len()));
                return;
            }
        }
        for key in self.source.missing() {
            if !before.contains(&key) {
                self.lacking.insert(key);
            }
        }
    }
}

fn install(
    svm: &mut LiteSVM,
    base: &mut LiteSVM,
    key: Pubkey,
    account: Account,
    notes: &mut Vec<String>,
) {
    for vm in [svm, base] {
        if vm.get_account(&key).is_some() {
            continue;
        }
        if let Err(error) = vm.set_account(key, account.clone()) {
            notes.push(format!(
                "account {key} could not be loaded locally: {error}"
            ));
        }
    }
}

/// Gives `key` SOL for transaction fees and rent.
pub fn fund_lamports(svm: &mut LiteSVM, key: &Pubkey) {
    const FUNDING: u64 = u64::MAX / 4;
    svm.set_account(
        *key,
        Account {
            lamports: FUNDING,
            data: vec![],
            owner: client::SYSTEM_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .expect("a system account can always be written");
}
