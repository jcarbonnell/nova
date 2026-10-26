// nova-sdk-rs/tests/access_window_live.rs
//
// §6.1 Piece 4 — LIVE access-window smoke (SDK path), Rust mirror of
// nova-sdk-js/tests/access-window.live.test.ts. Against gmail-14.nova-sdk.near on
// the fixture group `retention-exec-fixture` (production Shade must have
// SCHEDULER_ENABLED=true). Sells a 1-minute window through the SDK and checks it
// is ENFORCED: revoked about a minute after expiry, window removed.
// Self-skips without NOVA_API_KEY. Costs ~0.0000139 NEAR in fees + gas.

use nova_sdk_rs::{AddGroupMemberOptions, NovaSdk, NovaSdkConfig};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const ACCOUNT_ID: &str = "gmail-14.nova-sdk.near";
const GROUP: &str = "retention-exec-fixture";

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

#[tokio::test]
async fn live_access_window_is_enforced() {
    let Ok(api_key) = std::env::var("NOVA_API_KEY") else {
        eprintln!("NOVA_API_KEY not set — skipping live access-window smoke");
        return;
    };
    let sdk = NovaSdk::with_config(ACCOUNT_ID, NovaSdkConfig::default().with_api_key(&api_key)).unwrap();
    let member = format!("aw-rs-{}.near", now_ms());

    // Fixture sanity (free view).
    assert_eq!(sdk.get_group_owner(GROUP).await.unwrap().as_deref(), Some(ACCOUNT_ID));

    // A member without a window reads as None (the owner is a permanent member).
    assert!(sdk.get_member_window(GROUP, ACCOUNT_ID).await.unwrap().is_none());

    // 1. Sell a 1-minute window.
    let msg = sdk
        .add_group_member_with_options(GROUP, &member, AddGroupMemberOptions { access_minutes: Some(1) })
        .await
        .unwrap();
    assert!(msg.contains("with access until"), "unexpected: {msg}");

    // 2. Owner reads it; the member has access now.
    let win = sdk.get_member_window(GROUP, &member).await.unwrap().expect("window");
    assert!(win.expires_at_ms > now_ms() && win.expires_at_ms <= now_ms() + 65_000);
    assert!(sdk.is_authorized(GROUP, Some(&member)).await.unwrap());

    // 3. Wait for the scheduler (first tick after expiry + revoke/rotate/complete).
    let deadline = win.expires_at_ms + 150_000;
    let mut revoked = false;
    while now_ms() < deadline {
        tokio::time::sleep(Duration::from_secs(10)).await;
        if !sdk.is_authorized(GROUP, Some(&member)).await.unwrap() { revoked = true; break; }
    }
    assert!(revoked, "member still authorized 150 s after expiry");
    println!("✅ revoked {}s after expiry", (now_ms() - win.expires_at_ms) / 1000);

    // 4. The window entry is gone.
    let mut gone = false;
    for _ in 0..6 {
        if sdk.get_member_window(GROUP, &member).await.unwrap().is_none() { gone = true; break; }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
    assert!(gone, "window still present after revoke");
}