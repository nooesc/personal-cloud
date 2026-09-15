use crate::App;
use aes_gcm::{
    Aes256Gcm, KeyInit, Nonce,
    aead::{Aead, Payload},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rand::RngCore;
pub fn load_key() -> anyhow::Result<[u8; 32]> {
    let encoded = std::env::var("PC_SECRET_KEY")
        .map_err(|_| anyhow::anyhow!("PC_SECRET_KEY is required; run scripts/setup-env.py"))?;
    anyhow::ensure!(
        encoded.len() == 64,
        "PC_SECRET_KEY must be 64 hex characters"
    );
    let mut key = [0u8; 32];
    for (i, byte) in key.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&encoded[i * 2..i * 2 + 2], 16)?;
    }
    Ok(key)
}
pub fn seal(app: &App, context: &str, plaintext: &str) -> anyhow::Result<String> {
    encrypt(&app.secret_key, context, plaintext)
}
pub fn open(app: &App, context: &str, ciphertext: &str) -> anyhow::Result<String> {
    decrypt(&app.secret_key, context, ciphertext)
}
fn encrypt(key: &[u8; 32], context: &str, plaintext: &str) -> anyhow::Result<String> {
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid encryption key"))?;
    let mut nonce = [0u8; 12];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let data = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("Secret encryption failed"))?;
    let mut result = nonce.to_vec();
    result.extend(data);
    Ok(STANDARD.encode(result))
}
fn decrypt(key: &[u8; 32], context: &str, ciphertext: &str) -> anyhow::Result<String> {
    let data = STANDARD.decode(ciphertext)?;
    anyhow::ensure!(data.len() >= 28, "Invalid encrypted secret");
    let cipher =
        Aes256Gcm::new_from_slice(key).map_err(|_| anyhow::anyhow!("Invalid encryption key"))?;
    let value = cipher
        .decrypt(
            Nonce::from_slice(&data[..12]),
            Payload {
                msg: &data[12..],
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("Secret could not be decrypted; check encryption key"))?;
    Ok(String::from_utf8(value)?)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn roundtrip_and_context_isolation() {
        let key = [42; 32];
        let sealed = encrypt(&key, "project:1", "secret").unwrap();
        assert_eq!(decrypt(&key, "project:1", &sealed).unwrap(), "secret");
        assert!(decrypt(&key, "project:2", &sealed).is_err());
        assert!(decrypt(&[43; 32], "project:1", &sealed).is_err());
        assert_ne!(sealed, encrypt(&key, "project:1", "secret").unwrap());
    }
}
