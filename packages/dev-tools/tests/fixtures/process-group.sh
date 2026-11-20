#!/bin/sh
# Delay PID publication so the test cannot rely on the child starting promptly.
sleep 1
trap '' TERM
sleep 30 &
printf '%s %s\n' "$$" "$!" >&2
wait
