# Desktop ↔ Android server protocol (v1)

The server (`android-server/`) runs on the phone as
`CLASSPATH=/data/local/tmp/mirror-server.jar app_process / com.mirror.server.Server key=value...`
and listens on the abstract socket `mirror_<scid>`. The desktop reaches it with
`adb forward tcp:0 localabstract:mirror_<scid>` and opens **two** connections, in order:

1. **video** (device → desktop)
2. **control** (desktop → device)
3. **audio** (device → desktop), only with `audio=1`

All integers are big-endian.

## Server arguments

| Key | Default | Meaning |
|---|---|---|
| `scid` | required | 8 hex chars, makes the socket name unique per session |
| `max_size` | `0` | Cap on the long side in pixels (0 = native). Rounded down to a multiple of 8 |
| `bit_rate` | `8000000` | Encoder bitrate in bits/s |
| `max_fps` | `0` | Encoder frame-rate cap (0 = none) |
| `audio` | `0` | `1` opens a third socket with the phone's sound |
| `owner` | none | Hex id of the desktop install; lets it clean up only its own leftover servers |

## Video socket

On accept the server writes a handshake:

| Bytes | Field |
|---|---|
| 4 | magic `MIRR` |
| 1 | protocol version (`1`) |
| 1 | device name length `n` |
| n | device name (UTF-8) |

Then one **session header** per encoder (re)start. The server polls the display
every 300 ms and restarts the encoder when its size changes (rotation); the desktop
must reset its decoder at each header.

| Bytes | Field |
|---|---|
| 8 | `0xFFFFFFFFFFFFFFFF` marker |
| 2 | width |
| 2 | height |

Then packets:

| Bytes | Field |
|---|---|
| 8 | bit 63 = codec config, bit 62 = keyframe, bits 0-61 = PTS in µs |
| 4 | payload length |
| n | Annex-B H.264 payload |

Codec config packets (SPS/PPS) must be prepended to the next frame before decoding.

## Control socket

Each message starts with a 1-byte type. Coordinates are normalized `f32` in 0..1 of
the current display, so the same message works on any resolution (device farm).

| Type | Name | Payload |
|---|---|---|
| 0 | touch | action `u8` (0 down, 1 up, 2 move), pointer id `u32`, x `f32`, y `f32`, pressure `f32` |
| 1 | key | action `u8` (0 down, 1 up), Android keycode `i32`, repeat `i32`, meta state `i32` |
| 2 | text | length `u16`, UTF-8 bytes |
| 3 | scroll | x `f32`, y `f32`, horizontal `f32`, vertical `f32` |
| 4 | request keyframe | none |
| 5 | set clipboard | paste `u8` (1 = also inject Paste), length `u32`, UTF-8 bytes |
| 6 | set screen power | on `u8` (0 turns the physical screen off; restored when the session ends) |

The device also writes to the control socket:

| Type | Name | Payload |
|---|---|---|
| 0 | clipboard changed | length `u32`, UTF-8 bytes (text copied on the phone) |

Text that the virtual key map cannot type (Arabic, CJK, emoji) is set on the phone
clipboard and pasted instead.

## Audio socket

Starts with a 4-byte codec id: `0x00616163` for AAC-LC 48 kHz stereo, or `0`
(sound unavailable) followed by a 1-byte length and a UTF-8 reason. Then packets
in the video packet format; the first is the AudioSpecificConfig (bit 63 set),
the rest are raw AAC frames. Timestamps share the video clock.

Capture uses `REMOTE_SUBMIX`, which silences the phone's speaker while mirroring.

## Audio in the video stream (iPhone)

The iPhone streams have one channel, so audio rides in the video stream: the
macOS capture helper's stdout and the companion app's `video` connection.
An audio packet is the marker `0xFFFFFFFFFFFFFFFE` followed by a packet in the
video packet format. The first audio packet is the AudioSpecificConfig (bit 63
set), and the rest are raw AAC-LC frames of 1024 samples, stereo, at the phone's
sample rate (often 44.1 kHz). Timestamps share the video clock. Silent stretches
(ReplayKit sends nothing while the phone is quiet) are filled with silent
frames, so frames can be played and recorded back to back. The encoder for both
senders is `native/shared/AacEncoder.swift`.

## iPhone companion app link (v2)

The desktop listens on a random TCP port on all interfaces, but only while the
iPhone app is allowed in settings **and** a phone is paired or the pairing
window is open. It advertises `_mirror-desk._tcp` as `FreeFlect-<first 12 hex
of the certificate fingerprint>`, which says nothing about the computer or its
owner. Server: `crates/companion`; phone: `native/ios/MirrorCompanion/Shared/DesktopLink.swift`.

Every connection is **TLS 1.3**. The desktop has a self-signed P-256
certificate, generated once and kept in the app's profile, with the key
encrypted by the system keychain (`companion-identity.json`). Its SHA-256
(of the DER) is the *fingerprint*. A paired phone accepts no other certificate.

After TLS, the phone sends one JSON line (at most 4 KB, within 10 s) and the
desktop answers with one JSON line:

| `role` | Hello fields | Answer |
|---|---|---|
| `video`, `control` | `v: 2`, `deviceId`, `name`, `secret` | `{"ok":true,"name"}` |
| `pair` | `v: 2`, `deviceId`, `name`, `token` | `{"ok":true,"secret","name"}` |
| `pair-code` | `v: 2`, `deviceId`, `name`, `nonce` | see below |

A refusal is `{"ok":false,"reason"}`. A wrong secret adds `"paired":false`,
and the phone drops its pairing. Plain JSON instead of TLS (the app before
pairing existed) gets a plain refusal asking to update. Unknown phones never
cause a prompt on the computer.

**Secrets.** Pairing gives the phone 32 random bytes (`secret`, hex). The
desktop stores only their SHA-256 (`companion-devices.json`) and compares in
constant time. The phone stores `{fingerprint, secret, desktopName}` in the
keychain group `$(AppIdentifierPrefix)$(FF_BUNDLE_ID).shared`, shared with the
broadcast and share extensions.

**Pairing window.** Opened by Pair iPhone in settings, for 120 s or until a
phone pairs, whichever comes first. Three wrong tokens or codes close it.

**QR code:** `freeflect://pair?v=2&fp=<fingerprint>&t=<16-byte token>&n=<desktop name>`.
The phone pins `fp` before connecting and sends `t`.

**Typed code:** 8 characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, shown as
`XXXX-XXXX`. Typing ignores case and separators; `O` counts as `0`, and `I` and
`L` count as `1`. The phone doesn't know the fingerprint yet, so it accepts any
certificate and records the one it saw (`fp_seen`):

1. phone → `{"v":2,"role":"pair-code","deviceId","name","nonce":<16 bytes>}`
2. desktop → `{"nonce":<16 bytes>}`
3. both: `key = PBKDF2-HMAC-SHA256(code, "freeflect-pair-v2" ‖ fp ‖ phone nonce ‖ desktop nonce, 600 000 rounds, 32 bytes)`,
   where the desktop uses its own fingerprint and the phone uses `fp_seen`
4. phone → `{"proof": HMAC-SHA256(key, "phone")}`
5. desktop → `{"ok":true,"proof": HMAC-SHA256(key, "desktop"),"secret","name"}`

A man in the middle shows the phone a different certificate, so the two keys
differ and both proofs fail. Someone who records the exchange can only guess
codes offline at 600 000 rounds per guess, and the code is dead once the window
closes. The phone checks the desktop's proof before it pins `fp_seen`.

After the answer, the `video` connection carries the packet format above.
The desktop writes one-letter commands to it: `k\n` asks for a keyframe, `a\n`
asks for the iPhone's sound (then interleaved as above), and `m\n` keeps the
sound on the iPhone again. A broadcast starts without sound; the desktop sends
`a` only while a window plays it, so by default the sound stays on the phone. The
`control` connection carries frames of a u32 length plus JSON both ways:
`{"type":"clipboard","text"}`, or `{"type":"file","name","size"}` followed by
`size` bytes. Received files are flagged `com.apple.quarantine`, so macOS asks
before opening anything executable. A newer connection from the same phone in
the same role replaces the older one.
