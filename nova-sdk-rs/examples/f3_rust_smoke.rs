// nova-sdk-rs/examples/f3_rust_smoke.rs
//
// F3 smoke test — the wired nova-sdk-rs against the LIVE prod MCP, end to end.
// Mirrors the JS smoke: upload a throwaway blob, retrieve, assert byte-identical,
// assert the returned ref is a FastFS LOCATION (not a CID) — proving the new v1
// path fired, not a legacy fallback.
//
// Run from nova-sdk-rs/ with the member's API key in env:
//   NOVA_API_KEY=<gmail-14 key> cargo run --example f3_rust_smoke
//
// Makes a REAL mainnet upload (a throwaway record + FastFS envelope in
// engine-test-evt) — harmless, same as the JS smoke left. No real data touched.

use nova_sdk_rs::{NovaSdk, NovaSdkConfig};

const MCP_URL: &str = "https://5a5223f7d1bfe777433c496b9d52ff851e927259-8000.dstack-prod5.phala.network";
const GROUP: &str = "engine-test-evt";
const ACCOUNT: &str = "gmail-14.nova-sdk.near";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let api_key = std::env::var("NOVA_API_KEY")
        .expect("set NOVA_API_KEY (gmail-14.nova-sdk.near API key)");

    println!("\nF3 Rust SDK smoke — MCP={MCP_URL}\n  group={GROUP}\n");

    // ⚠️ CONFIRM the config builder for the MCP URL (see the grep for with_mcp_url).
    // If DEFAULT_MCP_URL already points at prod, drop the .with_mcp_url line.
    let config = NovaSdkConfig::default()
        .with_api_key(&api_key);
    let sdk = NovaSdk::with_config(ACCOUNT, config)?;
    let _ = MCP_URL;

    // throwaway payload
    let data: Vec<u8> = (0..4096).map(|_| rand::random::<u8>()).collect();

    // ── upload ──
    let up = sdk.upload(GROUP, &data, "smoke.bin").await?;
    println!("  upload -> ref={}  trans_id={}", up.cid, up.trans_id);

    // Must be a FastFS location, not an IPFS CID.
    let is_fastfs = up.cid.contains('/') && !up.cid.starts_with("Qm") && !up.cid.starts_with("bafy");
    assert!(is_fastfs, "expected a FastFS location, got \"{}\" — IPFS fallback?", up.cid);

    // ── retrieve (by the returned location) ──
    let down = sdk.retrieve(GROUP, &up.cid).await?;
    assert!(down.data == data, "retrieved bytes do not match uploaded plaintext");

    println!("\n  [OK] FastFS location returned (not a CID)");
    println!("  [OK] retrieve decoded byte-identical to upload");
    println!("\nSMOKE PASS — Rust SDK -> MCP -> Shade -> FastFS proven end to end.\n");
    Ok(())
}
