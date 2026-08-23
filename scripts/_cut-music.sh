#!/usr/bin/env bash
# Cut the owner's lounge mix into the twelve tracks the table plays, by the
# timecodes he listed. Output: frontend/assets/music/*.mp3 (gitignored — they
# are ~180 MB of binaries that never change, and they live on the VPS).
#
# Usage:  SRC=/path/to/mix.m4a bash scripts/_cut-music.sh
#         (needs ffmpeg · if the system has none:
#          npm i @ffmpeg-installer/ffmpeg  and set FF to its .path)
#
# TWO TRAPS, BOTH PAID FOR:
#
#  1. `-ss` BEFORE `-i` LIES ON THIS FILE. Fast seek landed up to ~254 seconds
#     off — the last track came out 18:34 instead of 22:47 — and, worse, the
#     other eleven had the RIGHT duration while starting in the wrong place, so
#     nothing looked broken. Matching durations prove nothing about the start.
#     Hence the full decode to WAV first: seeking a WAV is sample-exact.
#
#  2. ffmpeg READS STDIN and eats the lines of the `while read` loop, so the
#     loop ran one or two iterations out of twelve. Hence `-nostdin`.
set -eu

SRC="${SRC:-D:/Рабочий стол/examples/musicforcas.mp3}"
FF="${FF:-ffmpeg}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
# Overridable so a re-cut can be staged elsewhere and swapped in · Windows will
# refuse to overwrite a file some other program (a media player, an indexer)
# happens to have open, and a half-written track is worse than an old one.
OUT="${OUT:-$HERE/frontend/assets/music}"
WAV="${TMPDIR:-/tmp}/_music-decode.wav"
BITRATE="${BITRATE:-128k}"

mkdir -p "$OUT"
echo "decoding the whole mix once (accurate) …"
"$FF" -nostdin -hide_banner -v error -y -i "$SRC" -c:a pcm_s16le -ar 44100 -ac 2 "$WAV"

# start|end (seconds)|slug — from the owner's timecode list
TRACKS="
0|145|01-premium-lounge
145|484|02-romantic-jazz
484|940|03-dancing-with-somebody-new
940|1815|04-city-lights
1815|2600|05-gentle-piano
2600|3990|06-lobby-bar-jazz
3990|5444|07-deep-relaxation
5444|6763|08-i-remember
6763|7954|09-spa-ambience
7954|9625|10-morning-jazz
9625|10529|11-soft-evening-beats
10529|11896|12-final-harmony
"

echo "$TRACKS" | while IFS='|' read -r s e slug; do
  [ -z "${slug:-}" ] && continue
  d=$((e - s))
  # 1.2s in / 2s out: the source is one continuous mix, so a cut at a track
  # boundary would otherwise start and stop mid-phrase with a click. This is
  # also why the tracks are re-encoded rather than stream-copied: `-c copy`
  # would keep the source bit-for-bit but cannot fade.
  "$FF" -nostdin -hide_banner -v error -y -ss "$s" -t "$d" -i "$WAV" \
    -af "afade=t=in:st=0:d=1.2,afade=t=out:st=$((d - 2)):d=2" \
    -c:a libmp3lame -b:a "$BITRATE" -ar 44100 -ac 2 -write_xing 1 \
    -metadata title="$slug" "$OUT/$slug.mp3" \
    && printf "%-34s %5ds  %6.2f MB\n" "$slug" "$d" \
         "$(stat -c %s "$OUT/$slug.mp3" | awk '{print $1/1048576}')"
done

rm -f "$WAV"
echo "done · $(du -sh "$OUT" | cut -f1) in $OUT"
