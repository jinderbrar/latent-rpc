import json
import os
import platform
try:
    import psutil
except ImportError:
    psutil = None
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import logging

logger = logging.getLogger(__name__)

# Base paths
DATA_DIR = Path(__file__).parent.parent / "data" / "datasets"
REPORTS_DIR = Path(__file__).parent.parent / "reports"


def get_system_metadata() -> dict:
    """Auto-detect hardware specifications for research metadata."""
    meta = {
        "os": platform.system(),
        "os_version": platform.version(),
        "machine": platform.machine(),
        "processor": platform.processor(),
        "cpu_count_logical": os.cpu_count(),
    }
    try:
        if psutil:
            mem = psutil.virtual_memory()
            meta["ram_total_gb"] = round(mem.total / (1024**3), 2)
            meta["ram_available_gb"] = round(mem.available / (1024**3), 2)
        else:
            meta["ram_total_gb"] = "unknown (psutil not installed)"
            meta["ram_available_gb"] = "unknown (psutil not installed)"
    except Exception:
        meta["ram_total_gb"] = "unknown"
        meta["ram_available_gb"] = "unknown"
    return meta


def list_datasets() -> list[dict]:
    """Scan the datasets directory and return metadata for each dataset."""
    datasets = []
    if not DATA_DIR.exists():
        return datasets

    for f in sorted(DATA_DIR.glob("*.json")):
        try:
            with open(f, "r") as fh:
                prompts = json.load(fh)
            # Extract unique categories
            categories = sorted(set(p.get("category", "Unknown") for p in prompts))
            datasets.append({
                "id": f.stem,
                "filename": f.name,
                "prompt_count": len(prompts),
                "categories": categories,
            })
        except Exception as e:
            logger.warning(f"Failed to parse dataset {f.name}: {e}")
    return datasets


def get_dataset_prompts(dataset_id: str) -> list[dict]:
    """Load all prompts from a specific dataset."""
    filepath = DATA_DIR / f"{dataset_id}.json"
    if not filepath.exists():
        raise FileNotFoundError(f"Dataset '{dataset_id}' not found.")
    with open(filepath, "r") as f:
        return json.load(f)


def initialize_run(run_id: str, dataset_id: str, model_name: str) -> dict:
    """
    Create the report directory structure and write the initial metadata.json.
    Returns the metadata dict.
    """
    run_dir = REPORTS_DIR / run_id
    logs_dir = run_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    # Load dataset info for metadata
    dataset_prompts = get_dataset_prompts(dataset_id)

    metadata = {
        "run_id": run_id,
        "dataset_id": dataset_id,
        "dataset_prompt_count": len(dataset_prompts),
        "model": model_name,
        "timestamp_utc": datetime.now(timezone.utc).isoformat(),
        "status": "in_progress",
        "system": get_system_metadata(),
        "results_summary": None,
    }

    with open(run_dir / "metadata.json", "w") as f:
        json.dump(metadata, f, indent=2)

    logger.info(f"Research run initialized: {run_id} (dataset={dataset_id}, model={model_name})")
    return metadata


def append_log(run_id: str, log_entry: dict) -> None:
    """Append a single prompt benchmark result to the run's logs directory."""
    run_dir = REPORTS_DIR / run_id
    logs_dir = run_dir / "logs"

    if not logs_dir.exists():
        raise FileNotFoundError(f"Run '{run_id}' not found or not initialized.")

    prompt_id = log_entry.get("prompt_id", "unknown")
    log_file = logs_dir / f"{prompt_id}.json"

    with open(log_file, "w") as f:
        json.dump(log_entry, f, indent=2)

    logger.info(f"Log appended for run={run_id}, prompt={prompt_id}")


def generate_report(run_id: str) -> dict:
    """
    Aggregate all logs for a run into a final summary.
    Updates metadata.json with results and generates CSV.
    """
    run_dir = REPORTS_DIR / run_id
    logs_dir = run_dir / "logs"

    if not run_dir.exists():
        raise FileNotFoundError(f"Run '{run_id}' not found.")

    # Load all log files
    log_files = sorted(logs_dir.glob("*.json"))
    if not log_files:
        raise ValueError(f"No logs found for run '{run_id}'.")

    all_logs = []
    for lf in log_files:
        with open(lf, "r") as f:
            all_logs.append(json.load(f))

    # Aggregate metrics
    total_tokenWire_bytes = 0
    total_baseline_bytes = 0
    tokenWire_tps_values = []
    baseline_tps_values = []
    tokenWire_ttft_values = []
    baseline_ttft_values = []
    tokenWire_token_counts = []
    baseline_token_counts = []

    for log in all_logs:
        tokenWire = log.get("tokenWire", {})
        baseline = log.get("baseline", {})

        total_tokenWire_bytes += tokenWire.get("payloadBytes", 0)
        total_baseline_bytes += baseline.get("payloadBytes", 0)

        if tokenWire.get("tokensPerSecond"):
            tokenWire_tps_values.append(tokenWire["tokensPerSecond"])
        if baseline.get("tokensPerSecond"):
            baseline_tps_values.append(baseline["tokensPerSecond"])

        if tokenWire.get("timeToFirstTokenMs"):
            tokenWire_ttft_values.append(tokenWire["timeToFirstTokenMs"])
        if baseline.get("timeToFirstTokenMs"):
            baseline_ttft_values.append(baseline["timeToFirstTokenMs"])

        if tokenWire.get("totalTokens"):
            tokenWire_token_counts.append(tokenWire["totalTokens"])
        if baseline.get("totalTokens"):
            baseline_token_counts.append(baseline["totalTokens"])

    def _stats(values: list) -> dict:
        if not values:
            return {"mean": 0, "min": 0, "max": 0, "std_dev": 0, "count": 0}
        n = len(values)
        mean = sum(values) / n
        variance = sum((x - mean) ** 2 for x in values) / n if n > 1 else 0
        return {
            "mean": round(mean, 3),
            "min": round(min(values), 3),
            "max": round(max(values), 3),
            "std_dev": round(variance ** 0.5, 3),
            "count": n,
        }

    bandwidth_saved = total_baseline_bytes - total_tokenWire_bytes
    bandwidth_pct = (
        round((bandwidth_saved / total_baseline_bytes) * 100, 2)
        if total_baseline_bytes > 0
        else 0
    )

    summary = {
        "prompts_evaluated": len(all_logs),
        "total_tokenWire_bytes": total_tokenWire_bytes,
        "total_baseline_bytes": total_baseline_bytes,
        "bandwidth_saved_bytes": bandwidth_saved,
        "bandwidth_saved_pct": bandwidth_pct,
        "tokenWire_tps": _stats(tokenWire_tps_values),
        "baseline_tps": _stats(baseline_tps_values),
        "tokenWire_ttft_ms": _stats(tokenWire_ttft_values),
        "baseline_ttft_ms": _stats(baseline_ttft_values),
        "tokenWire_tokens": _stats(tokenWire_token_counts),
        "baseline_tokens": _stats(baseline_token_counts),
    }

    # Update metadata.json
    meta_path = run_dir / "metadata.json"
    with open(meta_path, "r") as f:
        metadata = json.load(f)
    metadata["status"] = "completed"
    metadata["completed_at_utc"] = datetime.now(timezone.utc).isoformat()
    metadata["results_summary"] = summary
    with open(meta_path, "w") as f:
        json.dump(metadata, f, indent=2)

    # Generate CSV
    _generate_csv(run_dir, all_logs)

    # Generate Markdown summary
    _generate_markdown(run_dir, metadata, summary)

    logger.info(f"Report generated for run={run_id}")
    return summary


def _generate_csv(run_dir: Path, logs: list[dict]) -> None:
    """Write a CSV file with per-prompt metrics."""
    csv_path = run_dir / "results.csv"
    headers = [
        "prompt_id", "category", "prompt",
        "tokenWire_bytes", "tokenWire_tps", "tokenWire_ttft_ms", "tokenWire_tokens",
        "baseline_bytes", "baseline_tps", "baseline_ttft_ms", "baseline_tokens",
        "bandwidth_saved_pct",
    ]

    lines = [",".join(headers)]
    for log in logs:
        tokenWire = log.get("tokenWire", {})
        baseline = log.get("baseline", {})
        b_bytes = baseline.get("payloadBytes", 0)
        l_bytes = tokenWire.get("payloadBytes", 0)
        saved_pct = round(((b_bytes - l_bytes) / b_bytes) * 100, 2) if b_bytes > 0 else 0

        row = [
            log.get("prompt_id", ""),
            log.get("category", ""),
            f'"{log.get("prompt", "")}"',
            str(l_bytes),
            str(round(tokenWire.get("tokensPerSecond", 0), 2)),
            str(round(tokenWire.get("timeToFirstTokenMs", 0), 2)),
            str(tokenWire.get("totalTokens", 0)),
            str(b_bytes),
            str(round(baseline.get("tokensPerSecond", 0), 2)),
            str(round(baseline.get("timeToFirstTokenMs", 0), 2)),
            str(baseline.get("totalTokens", 0)),
            str(saved_pct),
        ]
        lines.append(",".join(row))

    with open(csv_path, "w") as f:
        f.write("\n".join(lines))


def _generate_markdown(run_dir: Path, metadata: dict, summary: dict) -> None:
    """Write a Markdown research summary."""
    md_path = run_dir / "report.md"
    sys_info = metadata.get("system", {})

    md = f"""# TokenWire Research Report

## Run Metadata
| Field | Value |
|-------|-------|
| **Run ID** | `{metadata.get('run_id', 'N/A')}` |
| **Dataset** | `{metadata.get('dataset_id', 'N/A')}` |
| **Model** | `{metadata.get('model', 'N/A')}` |
| **Started** | `{metadata.get('timestamp_utc', 'N/A')}` |
| **Completed** | `{metadata.get('completed_at_utc', 'N/A')}` |
| **OS** | {sys_info.get('os', 'N/A')} {sys_info.get('os_version', '')[:30]} |
| **CPU** | {sys_info.get('processor', 'N/A')} ({sys_info.get('cpu_count_logical', '?')} cores) |
| **RAM** | {sys_info.get('ram_total_gb', '?')} GB total |

## Executive Summary
- **Prompts Evaluated**: {summary['prompts_evaluated']}
- **Total Bandwidth Saved**: {summary['bandwidth_saved_pct']}% ({summary['bandwidth_saved_bytes']} bytes)

## Bandwidth Analysis
| Protocol | Total Bytes | Avg TPS | Avg TTFT (ms) |
|----------|------------|---------|---------------|
| **TokenWire Binary** | {summary['total_tokenWire_bytes']:,} | {summary['tokenWire_tps']['mean']} | {summary['tokenWire_ttft_ms']['mean']} |
| **JSON Baseline** | {summary['total_baseline_bytes']:,} | {summary['baseline_tps']['mean']} | {summary['baseline_ttft_ms']['mean']} |

## Statistical Breakdown

### Tokens Per Second (TPS)
| Metric | TokenWire Binary | JSON Baseline |
|--------|-----------|---------------|
| Mean | {summary['tokenWire_tps']['mean']} | {summary['baseline_tps']['mean']} |
| Min | {summary['tokenWire_tps']['min']} | {summary['baseline_tps']['min']} |
| Max | {summary['tokenWire_tps']['max']} | {summary['baseline_tps']['max']} |
| Std Dev | {summary['tokenWire_tps']['std_dev']} | {summary['baseline_tps']['std_dev']} |

### Time To First Token (ms)
| Metric | TokenWire Binary | JSON Baseline |
|--------|-----------|---------------|
| Mean | {summary['tokenWire_ttft_ms']['mean']} | {summary['baseline_ttft_ms']['mean']} |
| Min | {summary['tokenWire_ttft_ms']['min']} | {summary['baseline_ttft_ms']['min']} |
| Max | {summary['tokenWire_ttft_ms']['max']} | {summary['baseline_ttft_ms']['max']} |
| Std Dev | {summary['tokenWire_ttft_ms']['std_dev']} | {summary['baseline_ttft_ms']['std_dev']} |

### Token Counts
| Metric | TokenWire Binary | JSON Baseline |
|--------|-----------|---------------|
| Mean | {summary['tokenWire_tokens']['mean']} | {summary['baseline_tokens']['mean']} |
| Total | {sum(t.get('tokenWire', {{}}).get('totalTokens', 0) for t in []) if False else 'See CSV'} | {'See CSV'} |

---
*Generated by TokenWire Research Suite*
"""

    with open(md_path, "w") as f:
        f.write(md)
