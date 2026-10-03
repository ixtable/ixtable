//! Browser hand-off sign-in (Google/Microsoft) with PKCE S256 (RFC 7636).
//!
//! Desktop opens `<site>/desktop-auth?code_challenge=…&state=…`; the signed-in
//! website approves the challenge; desktop polls `desktop-auth-exchange` with
//! the state and the verifier, which never leaves this process until then.
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    sync::{LazyLock, Mutex},
    time::{Duration, Instant},
};

/// How long a started sign-in may be completed.
pub const TTL: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, Clone)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
    pub state: String,
}

fn random(n: usize) -> String {
    let mut bytes = vec![0u8; n];
    OsRng.fill_bytes(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

/// `BASE64URL(SHA256(verifier))` without padding.
pub fn challenge_for(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

/// A 43-character verifier (32 random bytes), its challenge, and a state.
pub fn generate() -> Pkce {
    let verifier = random(32);
    Pkce {
        challenge: challenge_for(&verifier),
        state: random(24),
        verifier,
    }
}

static PENDING: LazyLock<Mutex<HashMap<String, (String, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Starts a sign-in and remembers its verifier by state.
pub fn begin() -> Pkce {
    let p = generate();
    let mut map = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    map.retain(|_, (_, at)| at.elapsed() < TTL);
    map.insert(p.state.clone(), (p.verifier.clone(), Instant::now()));
    p
}

/// The verifier of a pending, unexpired sign-in.
pub fn verifier(state: &str) -> Option<String> {
    let map = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    map.get(state)
        .filter(|(_, at)| at.elapsed() < TTL)
        .map(|(v, _)| v.clone())
}

pub fn finish(state: &str) {
    PENDING
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(state);
}

/// The website URL that approves this sign-in.
pub fn approve_url(site_url: &str, p: &Pkce, provider: Option<&str>) -> String {
    let mut url = format!(
        "{}/desktop-auth?code_challenge={}&code_challenge_method=S256&state={}",
        site_url.trim_end_matches('/'),
        p.challenge,
        p.state
    );
    if let Some(provider) = provider.filter(|p| matches!(*p, "google" | "azure")) {
        url.push_str("&provider=");
        url.push_str(provider);
    }
    url
}
