// nova/shade-agent/agent-contract/tests/attestation_check.rs
//
// §5.12 item 9.2 — offline pre-flight for the TEE flip.
//
// Runs the contract's OWN attestation check (shade_attestation::DstackAttestation::verify,
// the exact call made by verify_attestation() in src/internal/attestation.rs) against the
// real nova-tee-2 quote, the real Intel collateral and the real tcb_info, with the exact
// measurement set and PPID that 9.3 will approve. If this passes, register_agent will
// pass on-chain for the same CVM; if it fails, the flip would make Shade burn gas on a
// failed register_agent every 10 s, so we stop here.
//
// It derives nothing from memory:
//   - report_data and PPID come from the contract's own refusals (probes A and B);
//   - mrtd/rtmr0-2 come from tcb_info, and verify() proves they equal the quote's;
//   - key_provider_event_digest comes from the RTMR3 `key-provider` event, which
//     verify() proves by replaying RTMR3;
//   - app_compose_hash_payload is PINNED below to the hash registered on Base
//     (addComposeHash, item 8), and checked against the compose-hash event and
//     sha256(app_compose).
//
// Difference from the real registration, by construction: report_data here is the one
// inside the RA-TLS certificate's quote, not the agent account. The agent's report_data
// is built by shade-agent-js 2.2.0 exactly as the contract expects (32-byte implicit
// account + 32 zero bytes); probe M6 asserts the contract refuses any other value.
//
// Inputs (ATTEST_DIR, default ~/nova-ops/item9):
//   attestation.json  — `phala cvms attestation <cvm> --json`
//   collateral.json   — Phala's quote_collateral for that quote (same endpoint as shade-agent-js)
// Outputs (same dir):
//   approve_measurements.args.json  — {"measurements": FullMeasurementsHex}
//   approve_ppids.args.json         — {"ppids": [Ppid]}
//
// Run:  ATTEST_DIR=~/nova-ops/item9 cargo test --test attestation_check -- --ignored --nocapture

use serde_json::{json, Value};
use shade_attestation::{
    attestation::{DstackAttestation, VerificationError},
    collateral::Collateral,
    measurements::{create_mock_full_measurements_hex, FullMeasurements, FullMeasurementsHex, MeasurementsHex},
    quote::QuoteBytes,
    report_data::ReportData,
    tcb_info::{EventLog, HexBytes, TcbInfo},
};
use std::{fs, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

/// The compose hash registered on Base for app 0x7e9fF97D… (item 8). Pinned, not read.
const EXPECTED_COMPOSE_HASH: &str = "a163894b122510b47391715124d95d59df3097c98040e28c48406344609a15ac";
/// The CVM's app id (DstackApp address without 0x). Pinned, not read.
const EXPECTED_APP_ID: &str = "7e9ff97d35e21fdd0f5c819472217d19e772d017";

fn dir() -> PathBuf {
    std::env::var("ATTEST_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from(std::env::var("HOME").unwrap()).join("nova-ops/item9"))
}

fn hb<const N: usize>(s: &str, what: &str) -> HexBytes<N> {
    HexBytes::<N>::try_from(s.trim_start_matches("0x").to_string())
        .unwrap_or_else(|e| panic!("{what}: not {N} bytes of hex ({e})"))
}

fn flip<const N: usize>(h: &HexBytes<N>) -> HexBytes<N> {
    let mut a: [u8; N] = **h;
    a[N - 1] ^= 0x01;
    HexBytes::from(a)
}

fn single_event<'a>(log: &'a [EventLog], name: &str) -> &'a EventLog {
    let v: Vec<_> = log.iter().filter(|e| e.imr == 3 && e.event == name).collect();
    assert_eq!(v.len(), 1, "expected exactly one RTMR3 `{name}` event, found {}", v.len());
    v[0]
}

fn verify(
    a: &DstackAttestation,
    rd: [u8; 64],
    now: u64,
    m: &[FullMeasurementsHex],
    p: &[HexBytes<16>],
) -> Result<(FullMeasurements, HexBytes<16>), VerificationError> {
    let m: Vec<FullMeasurements> = m.iter().cloned().map(Into::into).collect();
    a.verify(ReportData::from(rd), now, &m, p)
}

/// Asserts a refusal and its exact message (or message prefix when the message carries
/// values this test does not know in advance).
fn refused(label: &str, r: Result<(FullMeasurements, HexBytes<16>), VerificationError>, exact: Option<&str>, prefix: &str) {
    match r {
        Ok(_) => panic!("MUTATION NOT CAUGHT [{label}]: verify() accepted it"),
        Err(e) => {
            let msg = e.to_string();
            match exact {
                Some(x) => assert_eq!(msg, x, "[{label}] wrong refusal"),
                None => assert!(msg.starts_with(prefix), "[{label}] wrong refusal: {msg}"),
            }
            println!("  ok  {label:<44} refused: {}", if msg.len() > 110 { &msg[..110] } else { &msg });
        }
    }
}

#[test]
#[ignore = "item 9.2 pre-flight: needs ATTEST_DIR with attestation.json + collateral.json"]
fn nova_tee_2_attestation_passes_the_contract_check() {
    let d = dir();
    let att: Value = serde_json::from_str(&fs::read_to_string(d.join("attestation.json")).expect("attestation.json")).unwrap();
    let col: Value = serde_json::from_str(&fs::read_to_string(d.join("collateral.json")).expect("collateral.json")).unwrap();
    let ti = &att["tcb_info"];

    // ── Inputs ────────────────────────────────────────────────────────────────
    let certs = att["app_certificates"].as_array().expect("app_certificates");
    let quote_hex = certs.iter().filter_map(|c| c["quote"].as_str()).next().expect("no quote in app_certificates");
    let quote = QuoteBytes::from(hex::decode(quote_hex.trim_start_matches("0x")).expect("quote hex"));
    let collateral = Collateral::try_from_json(col).expect("collateral.json is not Phala quote_collateral");

    let event_log: Vec<EventLog> = serde_json::from_value(ti["event_log"].clone()).expect("event_log");
    let app_compose = ti["app_compose"].as_str().expect("app_compose").to_string();

    // ── Independent anchors (pinned values, not read from the attestation) ───
    let ch_event = single_event(&event_log, "compose-hash");
    assert_eq!(ch_event.event_payload, EXPECTED_COMPOSE_HASH, "compose-hash event is not the hash registered on Base");
    assert_eq!(single_event(&event_log, "app-id").event_payload, EXPECTED_APP_ID, "app-id event is not nova-tee-2's app");
    let os_image = single_event(&event_log, "os-image-hash").event_payload.clone();
    let kp = single_event(&event_log, "key-provider");
    let kp_payload = String::from_utf8(hex::decode(&kp.event_payload).unwrap()).unwrap();
    assert!(kp_payload.starts_with(r#"{"name":"kms""#), "key provider is not the KMS: {kp_payload}");

    let tcb = TcbInfo {
        mrtd: hb(ti["mrtd"].as_str().unwrap(), "mrtd"),
        rtmr0: hb(ti["rtmr0"].as_str().unwrap(), "rtmr0"),
        rtmr1: hb(ti["rtmr1"].as_str().unwrap(), "rtmr1"),
        rtmr2: hb(ti["rtmr2"].as_str().unwrap(), "rtmr2"),
        rtmr3: hb(ti["rtmr3"].as_str().unwrap(), "rtmr3"),
        os_image_hash: Some(hb(&os_image, "os-image-hash")),
        compose_hash: hb(EXPECTED_COMPOSE_HASH, "compose hash"),
        device_id: HexBytes::default(), // not read by verify(); absent from the Phala API response
        app_compose: app_compose.clone(),
        event_log: event_log.clone(),
    };
    let att_ok = DstackAttestation::new(quote.clone(), collateral.clone(), tcb.clone());
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs();

    // ── Probe A: TCB status + the quote's report_data (from the contract's refusal) ──
    let rd = match verify(&att_ok, [0u8; 64], now, &[], &[]) {
        Err(VerificationError::WrongHash { name: "report_data", found, .. }) => {
            let b = hex::decode(&found).unwrap();
            <[u8; 64]>::try_from(b.as_slice()).unwrap()
        }
        Err(e @ (VerificationError::TcbStatusNotUpToDate(_) | VerificationError::NonEmptyAdvisoryIds(_))) => {
            panic!("STOP — the contract would refuse this platform whatever we approve: {e}")
        }
        other => panic!("probe A: unexpected result {:?}", other.map(|_| ())),
    };
    println!("TCB status UpToDate, no advisories (dcap verification passed)");

    // ── Probe B: the PPID (from the contract's refusal) ────────────────────────
    let ppid: HexBytes<16> = match verify(&att_ok, rd, now, &[], &[]) {
        Err(VerificationError::Custom(msg)) => {
            let h = msg
                .strip_prefix("PPID ")
                .and_then(|s| s.strip_suffix(" is not in the allowed PPIDs list"))
                .unwrap_or_else(|| panic!("probe B: unexpected message {msg}"));
            hb(h, "ppid")
        }
        other => panic!("probe B: unexpected result {:?}", other.map(|_| ())),
    };
    assert_ne!(ppid, HexBytes::default(), "PPID is the all-zero default");

    // ── The set 9.3 approves ───────────────────────────────────────────────────
    let cand = FullMeasurementsHex {
        rtmrs: MeasurementsHex {
            mrtd: tcb.mrtd.clone(),
            rtmr0: tcb.rtmr0.clone(),
            rtmr1: tcb.rtmr1.clone(),
            rtmr2: tcb.rtmr2.clone(),
        },
        key_provider_event_digest: kp.digest.clone(),
        app_compose_hash_payload: hb(EXPECTED_COMPOSE_HASH, "compose hash"),
    };

    // ── Positive: the contract's check accepts exactly this set and PPID ──────
    let (m, p) = verify(&att_ok, rd, now, &[cand.clone()], &[ppid.clone()]).expect("POSITIVE CASE REFUSED");
    assert_eq!(FullMeasurementsHex::from(m), cand, "verify() matched a different set");
    assert_eq!(p, ppid);
    println!("positive: accepted with the candidate set and PPID");

    // ── Mutations: each must be refused, by its specific message ──────────────
    const WRONG_SET: &str = "wrong expected_measurements hash (found none matched expected one of the embedded TCB info sets (prod or dev))";
    let with = |f: &dyn Fn(&mut FullMeasurementsHex)| { let mut c = cand.clone(); f(&mut c); c };

    refused("M1 mrtd one bit off", verify(&att_ok, rd, now, &[with(&|c| c.rtmrs.mrtd = flip(&c.rtmrs.mrtd))], &[ppid.clone()]), Some(WRONG_SET), "");
    refused("M2 rtmr0 one bit off", verify(&att_ok, rd, now, &[with(&|c| c.rtmrs.rtmr0 = flip(&c.rtmrs.rtmr0))], &[ppid.clone()]), Some(WRONG_SET), "");
    refused("M3 rtmr1 one bit off", verify(&att_ok, rd, now, &[with(&|c| c.rtmrs.rtmr1 = flip(&c.rtmrs.rtmr1))], &[ppid.clone()]), Some(WRONG_SET), "");
    refused("M4 rtmr2 one bit off", verify(&att_ok, rd, now, &[with(&|c| c.rtmrs.rtmr2 = flip(&c.rtmrs.rtmr2))], &[ppid.clone()]), Some(WRONG_SET), "");
    refused("M5 key-provider digest one bit off", verify(&att_ok, rd, now, &[with(&|c| c.key_provider_event_digest = flip(&c.key_provider_event_digest))], &[ppid.clone()]), Some(WRONG_SET), "");
    refused("M6 compose hash one bit off", verify(&att_ok, rd, now, &[with(&|c| c.app_compose_hash_payload = flip(&c.app_compose_hash_payload))], &[ppid.clone()]), Some(WRONG_SET), "");
    refused("M7 only the all-zero mock set approved", verify(&att_ok, rd, now, &[create_mock_full_measurements_hex()], &[ppid.clone()]), Some(WRONG_SET), "");
    refused("M8 only the default PPID approved", verify(&att_ok, rd, now, &[cand.clone()], &[HexBytes::default()]),
        Some(&format!("custom error: `PPID {} is not in the allowed PPIDs list`", hex::encode(*ppid))), "");
    refused("M9 report_data of another account", verify(&att_ok, { let mut r = rd; r[0] ^= 1; r }, now, &[cand.clone()], &[ppid.clone()]),
        None, "wrong report_data hash (found ");

    let mut t = tcb.clone();
    t.app_compose.push(' ');
    refused("M10 app_compose altered", verify(&DstackAttestation::new(quote.clone(), collateral.clone(), t), rd, now, &[cand.clone()], &[ppid.clone()]),
        None, "wrong app_compose_payload hash (found ");

    let mut t = tcb.clone();
    for e in t.event_log.iter_mut().filter(|e| e.imr == 3 && e.event == "instance-id") { e.event_payload = "00".repeat(20); }
    refused("M11 RTMR3 event log altered", verify(&DstackAttestation::new(quote.clone(), collateral.clone(), t), rd, now, &[cand.clone()], &[ppid.clone()]),
        None, "wrong event_digest hash (found ");

    let mut t = tcb.clone();
    t.compose_hash = flip(&t.compose_hash);
    refused("M12 tcb_info compose_hash != compose-hash event", verify(&DstackAttestation::new(quote.clone(), collateral.clone(), t), rd, now, &[cand.clone()], &[ppid.clone()]),
        None, "wrong app_compose_event_hash hash (found ");

    refused("M13 collateral checked 3 years from now", verify(&att_ok, rd, now + 3 * 365 * 86_400, &[cand.clone()], &[ppid.clone()]),
        None, "dcap verification failed: ");

    // ── Outputs for 9.3 ────────────────────────────────────────────────────────
    let m_args = serde_json::to_string(&json!({ "measurements": cand })).unwrap();
    let p_args = serde_json::to_string(&json!({ "ppids": [ppid] })).unwrap();
    fs::write(d.join("approve_measurements.args.json"), &m_args).unwrap();
    fs::write(d.join("approve_ppids.args.json"), &p_args).unwrap();

    println!("\nos-image-hash            {os_image}");
    println!("ppid                     {}", hex::encode(*ppid));
    println!("approve_measurements     {m_args}");
    println!("approve_ppids            {p_args}");
    println!("written to {}", d.display());
}