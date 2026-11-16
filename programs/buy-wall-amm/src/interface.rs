//! The arguments of Pipeline's strategy instructions, as this program declares them.
//!
//! They are the same Borsh types as `pipeline-strategy-interface`'s, field for field, so the
//! router's bytes decode into them unchanged. They are declared here only because Anchor's
//! IDL needs every instruction argument to derive Anchor's traits, which the interface
//! crate's types don't; the tests below check both encode identically. Return data uses the
//! interface crate's own types.

use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub enum TradeMode {
    ExactIn,
    ExactOut,
}

/// `pipeline_strategy_interface::TradeRequest`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct TradeRequest {
    pub mode: TradeMode,
    pub input_index: u8,
    pub output_index: u8,
    pub amount: u64,
    pub trader: Option<[u8; 32]>,
    pub extra: Vec<u8>,
}

/// `pipeline_strategy_interface::SwapRequest`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SwapRequest {
    pub trade: TradeRequest,
    pub amount_sent: u64,
    pub min_amount_out: u64,
}

/// `pipeline_strategy_interface::ResolveRequest`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct ResolveRequest {
    pub trade: TradeRequest,
    pub round: u8,
}

/// `pipeline_strategy_interface::SeedRequest`: the most to take from each escrow, in mint
/// order (the token, then wrapped SOL), and the creation parameters, Borsh-encoded as
/// [`crate::InitParams`].
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct SeedRequest {
    pub amounts: Vec<u64>,
    pub data: Vec<u8>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use pipeline_strategy_interface as psi;

    fn trades() -> Vec<(TradeRequest, psi::TradeRequest)> {
        let mut cases = vec![];
        for (mode, psi_mode) in [
            (TradeMode::ExactIn, psi::TradeMode::ExactIn),
            (TradeMode::ExactOut, psi::TradeMode::ExactOut),
        ] {
            for (trader, extra) in [(None, vec![]), (Some([9u8; 32]), vec![1, 2, 3])] {
                let ours = TradeRequest {
                    mode,
                    input_index: 1,
                    output_index: 0,
                    amount: u64::MAX - 7,
                    trader,
                    extra: extra.clone(),
                };
                let theirs = psi::TradeRequest {
                    mode: psi_mode,
                    input_index: 1,
                    output_index: 0,
                    amount: u64::MAX - 7,
                    trader,
                    extra,
                };
                cases.push((ours, theirs));
            }
        }
        cases
    }

    fn encode<T: AnchorSerialize>(value: &T) -> Vec<u8> {
        let mut bytes = vec![];
        value.serialize(&mut bytes).unwrap();
        bytes
    }

    #[test]
    fn arguments_encode_exactly_as_pipelines() {
        for (ours, theirs) in trades() {
            let theirs_bytes = borsh::to_vec(&theirs).unwrap();
            assert_eq!(encode(&ours), theirs_bytes);
            assert_eq!(TradeRequest::try_from_slice(&theirs_bytes).unwrap(), ours);

            let swap = SwapRequest {
                trade: ours.clone(),
                amount_sent: 5,
                min_amount_out: 6,
            };
            let psi_swap = psi::SwapRequest {
                trade: theirs.clone(),
                amount_sent: 5,
                min_amount_out: 6,
            };
            assert_eq!(encode(&swap), borsh::to_vec(&psi_swap).unwrap());

            let resolve = ResolveRequest {
                trade: ours,
                round: 3,
            };
            let psi_resolve = psi::ResolveRequest {
                trade: theirs,
                round: 3,
            };
            assert_eq!(encode(&resolve), borsh::to_vec(&psi_resolve).unwrap());
        }
    }

    #[test]
    fn the_seed_request_encodes_exactly_as_pipelines() {
        for (amounts, data) in [
            (vec![], vec![]),
            (vec![1, u64::MAX], vec![7; 75]),
            (vec![5, 6, 7], vec![0]),
        ] {
            let ours = SeedRequest {
                amounts: amounts.clone(),
                data: data.clone(),
            };
            let theirs = borsh::to_vec(&psi::SeedRequest { amounts, data }).unwrap();
            assert_eq!(encode(&ours), theirs);
            assert_eq!(SeedRequest::try_from_slice(&theirs).unwrap(), ours);
        }
    }
}
