#!/bin/sh
# Test fixture standing in for a real service's CLI entrypoint
# (docs/impl-plans/0010-exec-agent.md's T1-T9/T14). Echoes its own argv and
# stdin back as JSON on stdout so tests can assert exactly what the agent
# passed through. Supports two control flags consumed by this script
# itself (not passed through to the "echo" below):
#
#   --sleep-ms N     sleep N milliseconds before responding (for
#                     timeout/dedup-concurrency tests)
#   --exit-code N    exit with code N after responding (default 0)
#
# Also appends one line to $FAKE_CLI_INVOCATIONS_FILE (if set) per
# invocation, so concurrency tests can assert exactly how many real
# subprocesses were spawned.

sleep_ms=0
exit_code=0
args=""
first=1

while [ $# -gt 0 ]; do
  case "$1" in
    --sleep-ms)
      sleep_ms="$2"
      shift 2
      ;;
    --exit-code)
      exit_code="$2"
      shift 2
      ;;
    *)
      if [ $first -eq 1 ]; then
        args="\"$1\""
        first=0
      else
        args="$args,\"$1\""
      fi
      shift
      ;;
  esac
done

if [ -n "$FAKE_CLI_INVOCATIONS_FILE" ]; then
  echo "1" >> "$FAKE_CLI_INVOCATIONS_FILE"
fi

if [ "$sleep_ms" -gt 0 ] 2>/dev/null; then
  # sleep accepts fractional seconds on both GNU and BusyBox coreutils.
  sleep_seconds=$(awk "BEGIN { printf \"%.3f\", $sleep_ms/1000 }")
  sleep "$sleep_seconds"
fi

stdin_content=$(cat)

printf '{"args":[%s],"stdin":"%s"}\n' "$args" "$stdin_content"

exit "$exit_code"
