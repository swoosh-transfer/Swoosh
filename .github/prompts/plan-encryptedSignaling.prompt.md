## Plan: Encrypted Signaling (Replace TOFU with Signal-Layer Encryption)

**TL;DR**: Use the shared secret from the URL fragment (`#`) to derive an AES-GCM encryption key. Encrypt all signaling messages (SDP offer, SDP answer, ICE candidates) before they pass through the signaling server. If the WebRTC data channel establishes successfully, it proves both peers possess the secret — making TOFU challenge/response verification unnecessary. The signaling server only sees encrypted blobs and can never read SDP or ICE data.

### How it works (conceptually)

```
Current:  Secret in URL → plaintext signaling → data channel opens → TOFU verification over data channel
Proposed: Secret in URL → ENCRYPTED signaling → data channel opens → already verified (remove TOFU)
```

Only someone who has the link (and thus the secret) can decrypt the SDP offer, construct the WebRTC answer, and negotiate ICE — so the data channel establishing IS the proof of identity.

---

**Steps**

1. **Add AES-GCM encryption/decryption to `src/utils/tofuSecurity.js`**
   - Add `deriveEncryptionKey(secret)` — PBKDF2 from secret → AES-GCM-256 key (use a different salt than the existing HMAC derivation, e.g. `"signaling-encryption"`)
   - Add `encryptSignaling(plaintext, aesKey)` — generates a random 12-byte IV, encrypts with AES-GCM, returns `{iv, ciphertext}` both base64-encoded
   - Add `decryptSignaling(encryptedObj, aesKey)` — decodes IV + ciphertext from base64, decrypts with AES-GCM, returns parsed JSON
   - All using `crypto.subtle` (Web Crypto API, no external deps needed)

2. **Add encryption key management to signaling module `src/utils/signaling.js`**
   - Add `setEncryptionKey(aesKey)` — stores the derived AES key in module-level state (similar to how `currentRoom` is tracked)
   - Modify `sendOffer(offer, roomId)` — before emitting, encrypt the `offer` object using `encryptSignaling()`, emit `{ encrypted: true, payload: encryptedBlob, roomId }`
   - Modify `sendAnswer(answer, roomId)` — same pattern for the answer
   - Modify `sendIceCandidate(candidate, roomId)` — same pattern for ICE candidates
   - Modify `setupSignalingListeners()` handlers — in `onOffer`, `onAnswer`, `onIceCandidate`, detect encrypted payloads, decrypt using `decryptSignaling()` before passing to the handler callback

3. **Modify `src/utils/p2pManager.js` — encrypt outgoing ICE from `onicecandidate`**
   - The `peerConnection.onicecandidate` handler in `initializePeerConnection()` currently emits ICE directly via `socket.emit('ice-candidate', ...)`. Change it to use the `sendIceCandidate()` signaling function (which now encrypts), OR import and apply encryption inline
   - Modify `createOffer()` and `handleOffer()` — these directly call `socket.emit('offer', ...)` and `socket.emit('answer', ...)`. Route them through the encrypting `sendOffer()`/`sendAnswer()` functions from signaling.js instead

4. **Derive and set encryption key in `src/pages/Room/hooks/useRoomConnection.js`**
   - **Guest path** (line ~155): After parsing `securityPayload` from URL hash, call `deriveEncryptionKey(decoded.secret)` and then `setEncryptionKey(key)` BEFORE joining the room (so incoming offer can be decrypted)
   - **Host path**: The host already has `securityPayload` in the store (set by Home.jsx). In the WebRTC setup effect (~line 190), derive the encryption key from `securityPayload.secret` and call `setEncryptionKey(key)` BEFORE signaling listeners are set up
   - Both paths ensure the key is ready before any signaling messages are sent or received

5. **Simplify `src/pages/Room/hooks/useSecurity.js` — remove TOFU**
   - Remove `startTOFUVerification()`, `handleTOFUChallenge()`, `handleTOFUResponse()`, `handleTOFUVerified()` and all related state (`tofuStartedRef`, `challengeRef`, `hmacKeyRef`)
   - Keep `sendHandshake()` / `handleHandshake()` if you want session resumption with IndexedDB (optional, can remove too)
   - Change `tofuVerified` to become `true` automatically when the data channel opens (data channel open = signaling decrypted successfully = peer is verified)
   - Simplify `verificationStatus`: `'pending'` → `'verified'` on data channel open

6. **Update `src/pages/Room/index.jsx` — adjust data channel ready callback**
   - In the `onDataChannelReady` callback (~line 49), instead of calling `security.sendHandshake(channel)`, mark security as verified (or call a simplified version)
   - Remove TOFU message handling from `useMessages` if it dispatches `tofu-challenge`, `tofu-response`, `tofu-verified`

7. **Update message handling in `src/pages/Room/hooks/useMessages.js`**
   - Remove handlers for `tofu-challenge`, `tofu-response`, `tofu-verified` message types
   - Remove the pattern of queueing chunks until TOFU is verified (chunks can flow immediately once data channel opens)

8. **Clean up `src/constants/messages.constants.js`**
   - Remove (or deprecate) `tofu-challenge`, `tofu-response`, `tofu-verified` from `MESSAGE_TYPE`

9. **Clean up `src/utils/tofuSecurity.js`**
   - Keep: `generateSharedSecret()`, `generatePeerID()`, `createSecurityPayload()`, `parseSecurityPayload()`, `createSecurityURL()`, `extractSecurityFromURL()`, and the new encryption functions
   - Can deprecate/remove: `deriveHMACKey()`, `generateChallenge()`, `signChallenge()`, `verifyChallenge()`, `initiatePeerVerification()`, `SecuritySession` class (all TOFU-specific)
   - Consider renaming the file to `signalingCrypto.js` or similar since it's no longer TOFU

10. **Update SecurityService `src/services/security/SecurityService.js`** if it references TOFU methods (from research, it's not actively used by the UI, but clean it up for consistency)

---

**Verification**

- **Unit test**: Write a test that encrypts an SDP offer with a derived key, then decrypts it with the same key derived from the same secret — assert equality
- **Negative test**: Attempt to decrypt with a wrong secret — assert failure/error
- **Manual test (happy path)**: Host creates room → copies link → Guest opens link → data channel establishes → file transfer works. Open browser devtools Network tab and verify signaling messages (in Socket.IO frames) contain only encrypted blobs, not readable SDP
- **Manual test (attacker)**: Open the room URL WITHOUT the `#fragment` → guest cannot derive key → offer decryption fails → data channel never opens
- **Manual test (wrong secret)**: Manually tamper with the `#fragment` → decryption fails → connection never establishes

---

**Decisions**

- **AES-GCM-256 over AES-CBC**: GCM provides authentication + encryption (AEAD), preventing tampering. No need for separate HMAC.
- **PBKDF2 with separate salt**: Reuse existing PBKDF2 pattern but with salt `"signaling-encryption"` (different from TOFU's `"p2p-verification"`) so existing key material doesn't collide.
- **Encrypt at signaling layer, not socket layer**: Encryption wraps SDP/ICE payloads specifically, keeping room management messages (join, create) unencrypted (they need to work for the server to route).
- **Remove TOFU entirely**: Since encrypted signaling provides stronger guarantees (prevents MITM at the signaling layer itself, not just after-the-fact verification), TOFU is redundant.
- **Keep identity handshake optional**: The IndexedDB-based session tracking (`identityManager.js`) can stay if you want "returning peer" detection, but it's orthogonal to security.
