//! The exit checks over time and across wallets, end to end through devnet's router:
//! `exit_hold`, `exit_late`, `exit_launch_clock`, `exit_wallets`, `exit_transferred` and
//! `exit_queue`, on Pipeline's test strategies, Canary's own fixture strategy and a
//! Token-2022 mint whose transfer hook refuses wallet-to-wallet transfers.

mod common;

use canary::{run_market, MarketResults, Outcome, Record, RunOptions};
use common::{mode, Cluster};
use pipeline_check::SvmSource;
use pipeline_client::Pubkey;

const DAY: u64 = 86_400;

fn run(cluster: &Cluster, market: Pubkey) -> MarketResults {
    run_market(
        &mut SvmSource::new(cluster.svm.clone()),
        market,
        &RunOptions::default(),
    )
    .into_results()
    .expect("a full source never lacks an account")
}

const EXITS: [&str; 6] = [
    "exit_hold",
    "exit_late",
    "exit_launch_clock",
    "exit_wallets",
    "exit_transferred",
    "exit_queue",
];

fn counts_as_could_not_sell_back(record: &Record) -> bool {
    record.numbers["could_not_sell_back"]
        .as_bool()
        .unwrap_or_else(|| {
            panic!(
                "{} says whether it counts: {}",
                record.check, record.numbers
            )
        })
}

fn assert_outcome(record: &Record, outcome: Outcome) {
    assert_eq!(
        record.outcome, outcome,
        "{}: {}",
        record.check, record.reason
    );
}

#[test]
fn an_honest_market_passes_every_exit_check_and_none_counts_as_could_not_sell_back() {
    let mut cluster = Cluster::new();
    let market = cluster.sol_cp_market(30);
    cluster.pass_time(2 * DAY);

    let run = run(&cluster, market.market);

    for check in EXITS {
        let record = run.record(check);
        assert_outcome(record, Outcome::Pass);
        assert!(!counts_as_could_not_sell_back(record), "{check}");
    }
    assert!(!counts_as_could_not_sell_back(run.record("exit_sizes")));
    let hold = run.record("exit_hold");
    assert!(hold.reason.contains("0.01 SOL"), "{}", hold.reason);
    assert!(hold.reason.contains("30 days"), "{}", hold.reason);
    // The launch clock ran at every position, the market being two days old.
    let launch = run.record("exit_launch_clock");
    let rows = launch.numbers["pairs"][0]["rows"].as_array().unwrap();
    assert_eq!(rows.len(), 1 + canary::config::LAUNCH_CLOCK_SECONDS.len());
    assert_eq!(rows[1]["position"], "at the market's creation");
}

#[test]
fn a_launch_tax_shows_as_an_exit_launch_clock_warn_with_its_figures() {
    let mut cluster = Cluster::new();
    let market = cluster.fixture_market(mode::LAUNCH_TAX, Pubkey::new_unique());
    cluster.pass_time(2 * DAY);

    let run = run(&cluster, market.market);

    let launch = run.record("exit_launch_clock");
    assert_outcome(launch, Outcome::Warn);
    for words in [
        "at the market's creation",
        "10 seconds after creation",
        "1 minute after creation",
        "only the clock was set back",
    ] {
        assert!(launch.reason.contains(words), "{words}: {}", launch.reason);
    }
    assert!(
        !launch.reason.contains("10 minutes after"),
        "{}",
        launch.reason
    );
    // The figures rise with the time since creation, and from 10 minutes on match now.
    let returns: Vec<u64> = launch.numbers["pairs"][0]["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["return_ppm"].as_u64().unwrap())
        .collect();
    let now = returns[0];
    assert!(returns[1] < 11_000, "{returns:?}");
    assert!(returns[1] < returns[2] && returns[2] < returns[3] && returns[3] < returns[4]);
    assert!(
        returns[4..].iter().all(|r| r.abs_diff(now) <= 10),
        "{returns:?}"
    );
    assert!(!counts_as_could_not_sell_back(launch));
    // The tax is long over, so the present and everything after it pass.
    for check in [
        "exit_sizes",
        "exit_hold",
        "exit_late",
        "exit_wallets",
        "exit_queue",
    ] {
        assert_outcome(run.record(check), Outcome::Pass);
    }
}

#[test]
fn a_market_that_closes_later_warns_in_exit_hold_and_exit_late_naming_the_wait() {
    let mut cluster = Cluster::new();
    let market = cluster.fixture_market(mode::CLOSES, Pubkey::new_unique());
    // A day old: trading closes in another day.
    cluster.pass_time(DAY);

    let run = run(&cluster, market.market);

    let hold = run.record("exit_hold");
    assert_outcome(hold, Outcome::Warn);
    assert!(
        hold.reason
            .contains("could not sell after 3 days or after 30 days"),
        "{}",
        hold.reason
    );
    assert!(!hold.reason.contains("after 1 day"), "{}", hold.reason);
    // A wallet that bought and then could not sell counts in the trade box's notice.
    assert!(counts_as_could_not_sell_back(hold));
    let late = run.record("exit_late");
    assert_outcome(late, Outcome::Warn);
    assert!(
        late.reason.contains("failed 3 days later or 30 days later"),
        "{}",
        late.reason
    );
    // exit_late describes another time, so it never counts.
    assert!(!counts_as_could_not_sell_back(late));
    for check in [
        "exit_sizes",
        "exit_launch_clock",
        "exit_wallets",
        "exit_transferred",
        "exit_queue",
    ] {
        assert_outcome(run.record(check), Outcome::Pass);
    }
}

#[test]
fn a_strategy_that_pays_an_insider_more_than_a_fresh_wallet_fails_exit_wallets() {
    let mut cluster = Cluster::new();
    let creator = cluster.admin_key();
    let market = cluster.fixture_market(mode::INSIDER_PAID_MORE, creator);

    let run = run(&cluster, market.market);

    let wallets = run.record("exit_wallets");
    assert_outcome(wallets, Outcome::Fail);
    assert!(
        wallets.reason.starts_with(&format!(
            "The wallet that is the market creator, the strategy's upgrade authority and the mint authority of mint 1 ({creator}) got back"
        )),
        "{}",
        wallets.reason
    );
    assert!(
        wallets.reason.contains("where a fresh wallet got back"),
        "{}",
        wallets.reason
    );
}

#[test]
fn a_strategy_that_pays_an_insider_less_than_a_fresh_wallet_warns_in_exit_wallets() {
    let mut cluster = Cluster::new();
    let creator = cluster.admin_key();
    let market = cluster.fixture_market(mode::INSIDER_PAID_LESS, creator);

    let run = run(&cluster, market.market);

    let wallets = run.record("exit_wallets");
    assert_outcome(wallets, Outcome::Warn);
    assert!(
        wallets
            .reason
            .starts_with("The wallet that is the market creator"),
        "{}",
        wallets.reason
    );
}

#[test]
fn exit_wallets_trades_as_each_insider_and_skips_and_names_a_program_address() {
    let mut cluster = Cluster::new();
    let market = cluster.fixture_market(mode::FAIR, Pubkey::new_unique());
    // The token's mint authority handed to the market's state, a program-derived address.
    cluster.edit(&market.mint_b, |data| {
        data[4..36].copy_from_slice(market.state.as_ref())
    });

    let run = run(&cluster, market.market);

    let wallets = run.record("exit_wallets");
    assert_outcome(wallets, Outcome::Pass);
    assert!(
        wallets.reason.contains(&format!(
            "The mint authority of mint 1 ({}) is a program's address, not a wallet, and was skipped",
            market.state
        )),
        "{}",
        wallets.reason
    );
    let creator = cluster.admin_key();
    let who: Vec<&str> = wallets.numbers["pairs"][0]["wallets"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["who"].as_str().unwrap())
        .collect();
    assert_eq!(
        who,
        [
            "a fresh wallet",
            "a fresh wallet",
            "a fresh wallet",
            "a fresh wallet",
            "a fresh wallet",
            &format!("the wallet that is the market creator and the strategy's upgrade authority ({creator})"),
        ]
    );
}

#[test]
fn a_token_whose_hook_refuses_wallet_to_wallet_transfers_warns_and_never_counts_as_could_not_sell_back(
) {
    let mut cluster = Cluster::new();
    let market = cluster.hooked_market();
    cluster.pass_time(2 * DAY);

    let run = run(&cluster, market.market);

    let transferred = run.record("exit_transferred");
    assert_outcome(transferred, Outcome::Warn);
    assert!(
        transferred.reason.starts_with(&format!(
            "The token could not be sent to another wallet: its transfer hook {} refused",
            common::HOOK
        )),
        "{}",
        transferred.reason
    );
    assert!(
        transferred.reason.contains("the buyer got back"),
        "{}",
        transferred.reason
    );
    assert!(!counts_as_could_not_sell_back(transferred));
    assert_eq!(transferred.numbers["pairs"][0]["transferred"], false);
    // The hook's own refusal is named.
    assert_eq!(
        transferred.numbers["pairs"][0]["transfer_failure"]["program"],
        common::HOOK.to_string()
    );
    // Every other exit check buys and sells through the hook, with its accounts resolved.
    for check in [
        "exit_sizes",
        "exit_hold",
        "exit_late",
        "exit_launch_clock",
        "exit_wallets",
        "exit_queue",
        "quote_matches_swap",
    ] {
        assert_outcome(run.record(check), Outcome::Pass);
    }
}
