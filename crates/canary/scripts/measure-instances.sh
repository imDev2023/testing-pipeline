#!/usr/bin/env bash
# Measures Canary's image on Cloudflare's instance sizes (docs/spec/pipescope-architecture.md,
# "Canary runner": "The build measures a sweep on `basic` ... and whether ... `lite` serves"; #124).
# Docker caps a container at each size's vCPU and memory, with no network, as the deployed one has;
# every snapshot in <snapshot dir> is posted to it in turn, as `CanaryRun` posts them, and the time
# of each answer and of the whole pass is printed as tab-separated lines.
#
#   crates/canary/scripts/measure-instances.sh record <snapshot dir> <market>...   # snapshots, through devnet
#   crates/canary/scripts/measure-instances.sh run <snapshot dir> <basic|lite|standard-1> [image]
#
# `record` runs `canary snapshot` in the image with Docker's network (the only time it has one),
# writing <market>.json per market; `run` needs the image built:
#   docker build --platform linux/amd64 -t terminal-canary:dev -f crates/canary/Dockerfile crates
set -euo pipefail
cmd="${1:?usage: measure-instances.sh record|run <snapshot dir> ...}"
dir="${2:?snapshot dir}"
shift 2
image_default=terminal-canary:dev

case "$cmd" in
record)
  mkdir -p "$dir"
  for market in "$@"; do
    [ -s "$dir/$market.json" ] && continue
    if docker run --rm --platform linux/amd64 --entrypoint /usr/local/bin/canary "$image_default" snapshot --url devnet --market "$market" >"$dir/$market.json.part" 2>"$dir/$market.err"; then
      mv "$dir/$market.json.part" "$dir/$market.json"
      echo "recorded $market: $(tail -1 "$dir/$market.err")"
    else
      rm -f "$dir/$market.json.part"
      echo "could not record $market: $(tail -1 "$dir/$market.err")"
    fi
  done
  ;;
run)
  size="${1:?size: basic, lite or standard-1}"
  image="${2:-$image_default}"
  case "$size" in
  lite) cpus=0.0625 memory=256m ;;
  basic) cpus=0.25 memory=1g ;;
  standard-1) cpus=0.5 memory=4g ;;
  *) echo "unknown size $size" >&2; exit 2 ;;
  esac
  name="canary-measure-$size-$$"
  port=$((18100 + RANDOM % 800))
  # A published port needs a network; the container gets an internal one, which reaches nothing beyond Docker.
  docker network create --internal "$name" >/dev/null
  trap 'docker rm -f "$name" >/dev/null 2>&1; docker network rm "$name" >/dev/null 2>&1' EXIT
  docker run -d --rm --platform linux/amd64 --name "$name" --network "$name" --cpus "$cpus" --memory "$memory" "$image" >/dev/null
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$name")"
  # The host cannot reach an internal network directly, so a helper on it posts each snapshot;
  # each answer's time is curl's own, and the container's memory is read after each.
  total=0
  peak=0
  count=0
  for snapshot in "$dir"/*.json; do
    market="$(basename "$snapshot" .json)"
    out="$(docker run --rm -i --network "$name" curlimages/curl:8.11.1 -s -o /dev/null -w '%{http_code}\t%{time_total}' -X POST --data-binary @- -H 'content-type: application/json' --max-time 600 "http://$ip:8080/run" <"$snapshot" || printf 'error\t0')"
    mib="$(docker stats --no-stream --format '{{.MemUsage}}' "$name" | awk '{v=$1; if (v ~ /GiB/) {sub(/GiB/,"",v); v*=1024} else if (v ~ /MiB/) {sub(/MiB/,"",v)} else if (v ~ /KiB/) {sub(/KiB/,"",v); v/=1024} printf "%d", v}')"
    printf '%s\t%s\t%s\t%s MiB\n' "$size" "$market" "$out" "$mib"
    total="$(awk -v a="$total" -v b="$(printf '%s' "$out" | cut -f2)" 'BEGIN{printf "%.2f", a+b}')"
    [ "$mib" -gt "$peak" ] && peak="$mib"
    count=$((count + 1))
  done
  printf '%s\tall\t%s markets\t%s s answering\tmemory up to %s MiB\n' "$size" "$count" "$total" "$peak"
  ;;
*)
  echo "usage: measure-instances.sh record|run <snapshot dir> ..." >&2
  exit 2
  ;;
esac
