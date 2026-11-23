//! What the metadata publishes about the deployed program (docs/spec/README.md, "Metadata, IDL
//! and conformance report"), checked by `published-check` on this program's own files: the
//! README the metadata links exists, the committed conformance report (once there is one) is of
//! the deployed code and passes, and `metadata.json` publishes what `deployments/devnet.json`
//! records as deployed. The rules themselves are tested in `published-check`.
//!
//! Before the first deploy the links point at `main` and name no commit; the devnet ticket
//! pins them (docs/toolchain.md, "Deploy to devnet").

use published_check::{check_committed, Program};

const PROGRAM: Program = Program {
    dir: "programs/buy-wall-amm",
    name: "buy-wall-amm",
    idl: "buy_wall_amm.json",
};

#[test]
fn the_committed_metadata_and_report_publish_what_was_deployed() {
    check_committed(&PROGRAM).unwrap();
}
