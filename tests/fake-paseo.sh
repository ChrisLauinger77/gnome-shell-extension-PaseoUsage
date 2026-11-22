#!/bin/sh
# Fake paseo CLI for the runtime tests, with synthetic data only. The response delay
# (seconds) and the number of providers are read from files in $PASEO_FAKE_DIR.
if [ "$1" = "--version" ]; then
  echo "0.0.0-fake"
  exit 0
fi
sleep "$(cat "$PASEO_FAKE_DIR/delay")"
n=$(cat "$PASEO_FAKE_DIR/providers")
now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '['
i=1
while [ "$i" -le "$n" ]; do
  [ "$i" -gt 1 ] && printf ','
  printf '{"id":"p%d","sourceId":"fake","sourceLabel":"Provider %d","icon":null,"account":{"label":"test"},' "$i" "$i"
  printf '"fetchedAt":"%s","successfulAt":"%s","report":{"status":"available","planLabel":"Plan","windows":[' "$now" "$now"
  printf '{"id":"session","label":"Session","shortLabel":"5h","summary":true,"usedPct":%d,"tone":"ok"},' $((i * 7 % 100))
  printf '{"id":"week","label":"Weekly","shortLabel":"7d","summary":true,"usedPct":%d,"tone":"ok"}],' $((i * 13 % 100))
  printf '"balances":[],"details":[]}}'
  i=$((i + 1))
done
printf ']\n'
