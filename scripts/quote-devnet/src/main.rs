//! Quotes one live Pipeline market with `pipeline-quoter`, fed from a JSON-RPC endpoint,
//! and times each stage: fetching, loading the strategy, resolving accounts, the first
//! quote and 10,000 warm quotes. Uses `Quoter::quote` only, never `simulate_swap`, which
//! runs the BSL-licensed router.
//!
//!   cargo run --release -- <RPC_URL> list
//!   cargo run --release -- <RPC_URL> <MARKET> [AMOUNT] [INPUT_INDEX] [OUTPUT_INDEX]
//!
//! AMOUNT is exact-in, in the input mint's smallest units (default 1,000,000); the indexes
//! are positions in the market's mint list (default 0 -> 1). The trader is anonymous.

use std::collections::HashSet;
use std::time::{Duration, Instant};

use base64::Engine;
use pipeline_client::{self as client, Pubkey};
use pipeline_quoter::{MarketView, QuoteRequest, Quoter};
use pipeline_strategy_interface::TradeMode;
use serde_json::{json, Value};
use solana_account::Account;

const LOADER_V3: Pubkey = client::pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
const CLOCK: Pubkey = client::pubkey!("SysvarC1ock11111111111111111111111111111111");
const WARM_QUOTES: usize = 10_000;

struct Rpc {
    url: String,
    calls: u32,
    time: Duration,
}

impl Rpc {
    fn call(&mut self, method: &str, params: Value) -> Value {
        let body = json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params});
        let start = Instant::now();
        // Public RPC endpoints answer bursts with HTTP 429; back off and retry those.
        let mut attempt = 0;
        let mut response = loop {
            match ureq::post(&self.url)
                .header("content-type", "application/json")
                .send(body.to_string())
            {
                Err(ureq::Error::StatusCode(429)) if attempt < 6 => {
                    std::thread::sleep(Duration::from_millis(500 << attempt));
                    attempt += 1;
                }
                other => break other.unwrap_or_else(|e| panic!("{method}: {e}")),
            }
        };
        let text = response
            .body_mut()
            .with_config()
            .limit(64 * 1024 * 1024)
            .read_to_string()
            .unwrap_or_else(|e| panic!("{method}: {e}"));
        self.time += start.elapsed();
        self.calls += 1;
        let response: Value = serde_json::from_str(&text).expect("JSON-RPC response");
        if let Some(error) = response.get("error") {
            panic!("{method}: {error}");
        }
        response["result"].clone()
    }

    fn accounts(&mut self, keys: &[Pubkey]) -> Vec<Option<Account>> {
        let mut out = vec![];
        for chunk in keys.chunks(100) {
            let keys: Vec<String> = chunk.iter().map(|k| k.to_string()).collect();
            let result = self.call(
                "getMultipleAccounts",
                json!([keys, {"encoding": "base64", "commitment": "confirmed"}]),
            );
            for value in result["value"].as_array().expect("value array") {
                out.push((!value.is_null()).then(|| decode_account(value)));
            }
        }
        out
    }
}

fn decode_account(value: &Value) -> Account {
    Account {
        lamports: value["lamports"].as_u64().unwrap(),
        data: base64::engine::general_purpose::STANDARD
            .decode(value["data"][0].as_str().unwrap())
            .unwrap(),
        owner: value["owner"].as_str().unwrap().parse().unwrap(),
        executable: value["executable"].as_bool().unwrap(),
        rent_epoch: value["rentEpoch"].as_u64().unwrap_or(0),
    }
}

fn list(rpc: &mut Rpc) {
    let discriminator = client::account_discriminator("Market");
    let filter = base64::engine::general_purpose::STANDARD.encode(discriminator);
    let result = rpc.call(
        "getProgramAccounts",
        json!([client::PROGRAM_ID.to_string(), {
            "encoding": "base64",
            "filters": [{"memcmp": {"offset": 0, "bytes": filter, "encoding": "base64"}}]
        }]),
    );
    for item in result.as_array().expect("accounts") {
        let account = decode_account(&item["account"]);
        let Some(market) = client::decode_market(&account.data) else {
            continue;
        };
        println!(
            "{} strategy {} mints {} created_at {}",
            item["pubkey"].as_str().unwrap(),
            market.strategy_program,
            market.mint_count,
            market.created_at
        );
    }
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    sorted[((sorted.len() as f64 - 1.0) * p).round() as usize]
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut rpc = Rpc {
        url: args.get(1).expect("RPC_URL").clone(),
        calls: 0,
        time: Duration::ZERO,
    };
    if args.get(2).map(String::as_str) == Some("list") {
        list(&mut rpc);
        return;
    }
    let market_address: Pubkey = args
        .get(2)
        .expect("MARKET")
        .parse()
        .expect("market address");
    let amount: u64 = args
        .get(3)
        .map_or(1_000_000, |a| a.parse().expect("amount"));
    let input: usize = args.get(4).map_or(0, |a| a.parse().expect("input index"));
    let output: usize = args.get(5).map_or(1, |a| a.parse().expect("output index"));

    // 1. Market, strategy program and its bytecode.
    let total = Instant::now();
    let market_account = rpc
        .accounts(&[market_address])
        .remove(0)
        .expect("market exists");
    let market = client::decode_market(&market_account.data).expect("router Market account");
    let program = rpc
        .accounts(&[market.strategy_program])
        .remove(0)
        .expect("program exists");
    assert_eq!(
        program.owner, LOADER_V3,
        "strategy is not a loader-v3 program"
    );
    let program_data_address = Pubkey::new_from_array(program.data[4..36].try_into().unwrap());

    // 2. Everything the fixed account prefix reads, plus the clock.
    let mut keys = vec![
        program_data_address,
        market_address,
        market.market_state,
        CLOCK,
    ];
    keys.extend_from_slice(market.mints());
    keys.extend_from_slice(&market.vaults[..market.mint_count as usize]);
    let fetched = rpc.accounts(&keys);
    let fetch_time = total.elapsed();

    let mut quoter = Quoter::new();
    let load = Instant::now();
    quoter
        .load_program_from_program_data(
            market.strategy_program,
            &fetched[0].as_ref().expect("program data").data,
        )
        .expect("load strategy");
    let load_time = load.elapsed();

    let clock = &fetched[3].as_ref().expect("clock").data;
    let slot = u64::from_le_bytes(clock[0..8].try_into().unwrap());
    let epoch = u64::from_le_bytes(clock[16..24].try_into().unwrap());
    let unix_timestamp = i64::from_le_bytes(clock[32..40].try_into().unwrap());
    quoter.set_clock(slot, epoch, unix_timestamp);

    let mut cached: HashSet<Pubkey> = HashSet::new();
    for (key, account) in keys.iter().zip(&fetched).skip(1) {
        if *key == CLOCK {
            continue;
        }
        if let Some(account) = account {
            quoter
                .set_account(*key, account.clone())
                .expect("cache account");
            cached.insert(*key);
        }
    }
    let token_programs: Vec<Pubkey> = fetched[4..4 + market.mint_count as usize]
        .iter()
        .map(|m| m.as_ref().expect("mint exists").owner)
        .collect();
    let view = MarketView::from_market(market_address, &market, token_programs).expect("view");

    // 3. Account resolution, loading whatever the strategy asks for.
    let request = QuoteRequest {
        input_mint: view.mints[input],
        output_mint: view.mints[output],
        mode: TradeMode::ExactIn,
        amount,
        trader: None,
        integrator_fee_bps: 0,
        extra: vec![],
    };
    let mut fetch_missing = |quoter: &mut Quoter, keys: &[Pubkey], rpc: &mut Rpc| {
        let missing: Vec<Pubkey> = keys
            .iter()
            .filter(|k| !cached.contains(k))
            .copied()
            .collect();
        if missing.is_empty() {
            return;
        }
        for (key, account) in missing.iter().zip(rpc.accounts(&missing)) {
            cached.insert(*key);
            match account {
                Some(a) if a.executable || a.owner.to_string().starts_with("Sysvar") => {}
                Some(a) => quoter.set_account(*key, a).expect("cache account"),
                None => {}
            }
        }
    };
    let resolve = Instant::now();
    let strategy_accounts = {
        let rpc = &mut rpc;
        let fetch = &mut fetch_missing;
        quoter
            .resolve_accounts(&view, &request, |q, keys| fetch(q, keys, rpc))
            .expect("resolve accounts")
    };
    let resolved: Vec<Pubkey> = strategy_accounts.iter().map(|m| m.pubkey).collect();
    fetch_missing(&mut quoter, &resolved, &mut rpc);
    let resolve_time = resolve.elapsed();

    // 4. Quotes: the first one, then many warm ones.
    let first = Instant::now();
    let quote = quoter
        .quote(&view, &request, &strategy_accounts)
        .expect("quote");
    let first_time = first.elapsed();
    let mut times = Vec::with_capacity(WARM_QUOTES);
    for _ in 0..WARM_QUOTES {
        let start = Instant::now();
        let again = quoter
            .quote(&view, &request, &strategy_accounts)
            .expect("quote");
        times.push(start.elapsed());
        assert_eq!(again, quote, "quotes must be deterministic");
    }
    times.sort();
    let mean = times.iter().sum::<Duration>() / WARM_QUOTES as u32;

    println!("market         {market_address}");
    println!("strategy       {}", market.strategy_program);
    println!(
        "program data   {} bytes",
        fetched[0].as_ref().unwrap().data.len()
    );
    println!("clock          slot {slot}, epoch {epoch}, unix {unix_timestamp}");
    println!(
        "trade          exact-in {amount} of mint {input} -> mint {output}, {} strategy accounts",
        resolved.len()
    );
    println!("quote          {quote:?}");
    println!(
        "rpc            {} calls, {:.0} ms",
        rpc.calls,
        rpc.time.as_secs_f64() * 1e3
    );
    println!(
        "fetch          {:.0} ms (market, program, accounts)",
        fetch_time.as_secs_f64() * 1e3
    );
    println!("load program   {:.2} ms", load_time.as_secs_f64() * 1e3);
    println!(
        "resolve        {:.2} ms (including any RPC it needed)",
        resolve_time.as_secs_f64() * 1e3
    );
    println!("first quote    {:.1} us", first_time.as_secs_f64() * 1e6);
    println!(
        "warm quote     mean {:.1} us, p50 {:.1} us, p99 {:.1} us, over {WARM_QUOTES}",
        mean.as_secs_f64() * 1e6,
        percentile(&times, 0.5).as_secs_f64() * 1e6,
        percentile(&times, 0.99).as_secs_f64() * 1e6
    );
    println!(
        "end to end     {:.0} ms",
        total.elapsed().as_secs_f64() * 1e3
    );
}
