import json
import os
import gc
import asyncio
import time
from typing import AsyncGenerator
from app.core.config import settings
import logging
from llama_cpp import Llama

logger = logging.getLogger(__name__)

MAX_TOKENS = 128

# ─── Model resolution helper ──────────────────────────────────────────────────

def _resolve_model_path(model_name: str) -> str:
    """Resolve a model name like 'qwen2.5-coder:1.5b' to its GGUF blob path."""
    parts = model_name.split(":")
    model_dir = parts[0]
    model_tag  = parts[1] if len(parts) > 1 else "latest"

    manifest_path = os.path.expanduser(
        f"~/.ollama/models/manifests/registry.ollama.ai/library/{model_dir}/{model_tag}"
    )
    with open(manifest_path, "r") as f:
        manifest = json.load(f)

    for layer in manifest.get("layers", []):
        if layer.get("mediaType") == "application/vnd.ollama.image.model":
            digest    = layer["digest"]
            blob_name = digest.replace(":", "-")
            return os.path.expanduser(f"~/.ollama/models/blobs/{blob_name}")

    raise RuntimeError(f"Could not find model blob for {model_name}")


def _load_llama(model_path: str, label: str) -> Llama:
    logger.info(f"[{label}] Loading Llama instance from: {model_path}")
    return Llama(model_path=model_path, n_ctx=2048, n_gpu_layers=-1, verbose=False)


# ─── ModelManager ─────────────────────────────────────────────────────────────

class ModelManager:
    """
    Maintains TWO independent Llama instances:
      - _baseline_instance  → used by /ws/baseline (JSON token stream)
      - _tokenWire_instance    → used by /ws/stream   (binary token ID stream)

    Each instance has its own KV cache, so there is no cross-contamination
    between a baseline run and a tokenWire run. Cache clearing between prompts
    is no longer necessary.
    """

    _baseline_instance: Llama | None = None
    _tokenWire_instance:   Llama | None = None
    _current_model_name: str = getattr(settings, "LLM_MODEL_NAME", "qwen2.5-coder:1.5b")

    # ── Discovery ──────────────────────────────────────────────────────────────

    @classmethod
    def get_available_models(cls) -> list[str]:
        models = []
        manifest_base = os.path.expanduser(
            "~/.ollama/models/manifests/registry.ollama.ai/library"
        )
        if os.path.exists(manifest_base):
            for model_dir in os.listdir(manifest_base):
                tags_dir = os.path.join(manifest_base, model_dir)
                if os.path.isdir(tags_dir):
                    for tag in os.listdir(tags_dir):
                        models.append(f"{model_dir}:{tag}")
        return models

    # ── Loading ────────────────────────────────────────────────────────────────

    @classmethod
    def load_model(cls, model_name: str):
        """
        Load (or reload) BOTH instances with the given model.
        Frees existing instances first to reclaim memory.
        """
        if (
            cls._baseline_instance is not None
            and cls._tokenWire_instance is not None
            and cls._current_model_name == model_name
        ):
            logger.info(f"Model '{model_name}' already loaded as dual instances — skipping.")
            return

        logger.info(f"Loading dual Llama instances for model: {model_name}")

        # Free existing instances
        cls._free_instances()

        try:
            model_path = _resolve_model_path(model_name)
        except Exception as e:
            logger.error(f"Failed to resolve model path for '{model_name}': {e}")
            raise

        cls._baseline_instance = _load_llama(model_path, "BASELINE")
        cls._tokenWire_instance   = _load_llama(model_path, "TOKENWIRE")
        cls._current_model_name = model_name

        logger.info(f"Dual instances ready for model: {model_name}")

    @classmethod
    def _free_instances(cls):
        if cls._baseline_instance is not None:
            del cls._baseline_instance
            cls._baseline_instance = None
        if cls._tokenWire_instance is not None:
            del cls._tokenWire_instance
            cls._tokenWire_instance = None
        gc.collect()

    # ── Getters ────────────────────────────────────────────────────────────────

    @classmethod
    def get_baseline_llm(cls) -> Llama:
        if cls._baseline_instance is None:
            cls.load_model(cls._current_model_name)
        return cls._baseline_instance  # type: ignore

    @classmethod
    def get_tokenWire_llm(cls) -> Llama:
        if cls._tokenWire_instance is None:
            cls.load_model(cls._current_model_name)
        return cls._tokenWire_instance  # type: ignore

    # Keep for backwards compatibility (e.g. any code that calls get_llm())
    @classmethod
    def get_llm(cls) -> Llama:
        return cls.get_baseline_llm()

    # ── Cache reset (optional, kept for the HTTP endpoint) ────────────────────

    @classmethod
    def reset_cache(cls):
        """Reset KV caches on both instances independently."""
        if cls._baseline_instance is not None:
            cls._baseline_instance.reset()
            logger.info("Baseline KV cache reset.")
        if cls._tokenWire_instance is not None:
            cls._tokenWire_instance.reset()
            logger.info("TokenWire KV cache reset.")


# ─── Stream generators ────────────────────────────────────────────────────────

async def llama_tokenWire_generator(prompt: str) -> AsyncGenerator[list[int], None]:
    """
    Yields batches of raw token IDs from the TOKENWIRE instance.
    Stops on:
      1) model EOS token
      2) MAX_TOKENS generated tokens
    """
    llm = ModelManager.get_tokenWire_llm()
    eos_id = llm.token_eos()
    start_time = time.time()

    try:
        prompt_tokens = llm.tokenize(prompt.encode("utf-8"))
        count = 0
        batch: list[int] = []
        is_first = True

        for token_id in llm.generate(prompt_tokens, temp=0.0):
            token_id = int(token_id)

            if token_id == eos_id or count >= MAX_TOKENS:
                break

            batch.append(token_id)
            count += 1

            # Flush first token immediately for tight TTFT
            if is_first:
                yield batch
                await asyncio.sleep(0) # Flush to event loop
                batch = []
                is_first = False
            elif len(batch) >= 4:
                yield batch
                batch = []
                await asyncio.sleep(0)

        if batch:
            yield batch
            await asyncio.sleep(0)

    except Exception as e:
        logger.error(f"TokenWire generator error: {e}")
        raise
    finally:
        elapsed = time.time() - start_time
        logger.info(f"[TOKENWIRE] Generation finished in {elapsed:.3f}s ({count} tokens)")
        llm.reset()


async def llama_baseline_generator(prompt: str) -> AsyncGenerator[str, None]:
    """
    Yields decoded text pieces from the BASELINE instance.
    Uses the same stopping conditions as llama_tokenWire_generator:
      1) model EOS token
      2) MAX_TOKENS generated tokens
    """
    llm = ModelManager.get_baseline_llm()
    eos_id = llm.token_eos()
    start_time = time.time()
    count = 0

    try:
        prompt_tokens = llm.tokenize(prompt.encode("utf-8"))

        for token_id in llm.generate(prompt_tokens, temp=0.0):
            token_id = int(token_id)

            if token_id == eos_id or count >= MAX_TOKENS:
                break

            text = llm.detokenize([token_id]).decode("utf-8", errors="ignore")
            count += 1

            if text:
                yield text
                await asyncio.sleep(0)

    except Exception as e:
        logger.error(f"Baseline generator error: {e}")
        raise
    finally:
        elapsed = time.time() - start_time
        logger.info(f"[BASELINE] Generation finished in {elapsed:.3f}s ({count} tokens)")
        llm.reset()