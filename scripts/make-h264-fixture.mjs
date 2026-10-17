// Generates a phone-shaped Annex-B H.264 test stream for the decode spike.
// No B-frames and a 1 s GOP, like a phone hardware encoder in low-latency mode.
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'

mkdirSync('fixtures', { recursive: true })
execFileSync('ffmpeg', [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-f', 'lavfi', '-i', 'testsrc2=size=1080x2340:rate=60:duration=10',
  '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
  '-tune', 'zerolatency', '-bf', '0', '-g', '60', '-b:v', '8M',
  '-x264-params', 'repeat-headers=1',
  '-f', 'h264', 'fixtures/sample-1080p60.h264'
], { stdio: 'inherit' })
console.log('wrote fixtures/sample-1080p60.h264')
