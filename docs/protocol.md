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
