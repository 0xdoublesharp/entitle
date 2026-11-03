"""Run Entitle's real local API and billing reader against an owned StripeDouble.

Synthetic bootstrap credentials travel only through pipes and never enter logs.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
APP = Path(os.environ.get("STRIPE_DOUBLE_APP", ROOT.parent / "stripe-double")).resolve(strict=True)
WORK_ROOT = Path(os.environ.get("STRIPE_DOUBLE_WORK_ROOT", "/Volumes/Scratch/entitle/tmp")).resolve(strict=True)
sys.path.insert(0, str(APP))
from stripe_double.harness import StripeDouble


def main():
    with tempfile.TemporaryDirectory(prefix="stripe-double-entitle-", dir=WORK_ROOT) as directory:
        work = Path(directory)
        with StripeDouble(APP, work / "stripe.sqlite", api_version="2026-09-30.endive") as sim:
            status, seeded = sim.request(
                "POST", f"/__simulator/v1/runs/{sim.run_id}/billing/subscriptions/seed",
                json_body={"amount": "1200", "expected_state_version": 1}, admin=True,
            )
            if status != 200:
                raise RuntimeError("Synthetic subscription seeding failed")
            status, refunded = sim.request(
                "POST", "/v1/refunds", form={"charge": seeded["charge"], "amount": "400", "refund_application_fee": "false"}, key="entitle-partial-refund",
            )
            if status != 200 or refunded.get("status") != "succeeded":
                raise RuntimeError("Synthetic partial refund failed")
            payload = {"origin": sim.origin, "instance": sim.instance_id, "run": sim.run_id,
                       "apiVersion": sim.api_version, "apiKey": sim.api_key,
                       "publicKey": sim.public_key, "webhookSecret": sim.webhook_secret,
                       "work": str(work), **seeded}
            child = subprocess.run(
                [os.environ.get("NODE_BINARY", "node"), "--no-warnings", str(ROOT / "scripts/stripe-double-consumer.mjs")],
                cwd=ROOT, input=json.dumps(payload), text=True, capture_output=True, timeout=60,
            )
            if child.returncode != 0:
                raise RuntimeError(f"Entitle simulator integration failed: {child.stderr.strip()}")
            if child.stdout.strip() != "Entitle StripeDouble integration passed":
                raise RuntimeError("Unexpected Entitle simulator integration result")
            print(child.stdout.strip())


if __name__ == "__main__":
    main()
