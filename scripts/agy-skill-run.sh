#!/usr/bin/env bash
# agy-skill-run.sh — run a skill command handed by the agy skill-run hook
# (web-jam-tools#1319, #1480).
#
# Takes optional identity flags (--conversation-id, --model-name, --transcript-path)
# and one command as a single argument, and runs it with `bash -c` in the
# current working directory, passing the output and exit status back unchanged.
set -u

# Only this invocation's hook flags supply identity; never fill gaps from a parent run.
unset AGY_CONVERSATION_ID AGY_MODEL_NAME AGY_TRANSCRIPT_PATH

while [ $# -gt 0 ]; do
  case "$1" in
    --conversation-id)
      if [ $# -lt 2 ]; then
        echo "Usage: agy-skill-run.sh [--conversation-id <id>] [--model-name <name>] [--transcript-path <path>] <command>" >&2
        exit 1
      fi
      export AGY_CONVERSATION_ID="$2"
      shift 2
      ;;
    --model-name)
      if [ $# -lt 2 ]; then
        echo "Usage: agy-skill-run.sh [--conversation-id <id>] [--model-name <name>] [--transcript-path <path>] <command>" >&2
        exit 1
      fi
      export AGY_MODEL_NAME="$2"
      shift 2
      ;;
    --transcript-path)
      if [ $# -lt 2 ]; then
        echo "Usage: agy-skill-run.sh [--conversation-id <id>] [--model-name <name>] [--transcript-path <path>] <command>" >&2
        exit 1
      fi
      export AGY_TRANSCRIPT_PATH="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Unknown option: $1" >&2
      echo "Usage: agy-skill-run.sh [--conversation-id <id>] [--model-name <name>] [--transcript-path <path>] <command>" >&2
      exit 1
      ;;
    *)
      break
      ;;
  esac
done

if [ "$#" -ne 1 ]; then
  echo "Usage: agy-skill-run.sh [--conversation-id <id>] [--model-name <name>] [--transcript-path <path>] <command>" >&2
  exit 1
fi

exec bash -c "$1"
