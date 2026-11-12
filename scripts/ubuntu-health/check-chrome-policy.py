"""Read-only comparison of the installed Chrome policy with its root-owned reference."""

import json
import sys
from collections import Counter


def read_policy(path):
    with open(path, encoding="utf-8") as policy_file:
        policy = json.load(policy_file)
    if not isinstance(policy, dict):
        raise ValueError("expected a JSON object")
    return policy


def main():
    try:
        expected = read_policy(sys.argv[1])
        actual = read_policy(sys.argv[2])
    except (OSError, ValueError) as error:
        print(f"cannot read Chrome policy: {error}")
        return 1

    findings = []
    for key, wanted in expected.items():
        value = actual.get(key)
        if isinstance(wanted, list):
            if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
                findings.append(f"{key}: expected a list of strings, got {json.dumps(value)}")
                continue
            for label, difference in [
                ("missing", Counter(wanted) - Counter(value)),
                ("unexpected", Counter(value) - Counter(wanted)),
            ]:
                for item in difference.elements():
                    findings.append(f"{key}: {label} {json.dumps(item)}")
        elif type(value) is not type(wanted) or value != wanted:
            findings.append(f"{key}: expected {json.dumps(wanted)}, got {json.dumps(value)}")
    for key in actual.keys() - expected.keys():
        findings.append(f"unexpected policy key: {json.dumps(key)}")
    for finding in findings:
        print(finding)
    return int(bool(findings))


if __name__ == "__main__":
    sys.exit(main())
