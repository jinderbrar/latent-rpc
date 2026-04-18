from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.core.config import settings
from app.services.reporting import (
    list_datasets,
    get_dataset_prompts,
    initialize_run,
    append_log,
    generate_report,
)
from app.services.model_manager import ModelManager
import logging

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/research", tags=["research"])


# --- Request Models ---

class StartRunRequest(BaseModel):
    run_id: str
    dataset_id: str
    model: Optional[str] = None  # Falls back to settings.LLM_MODEL_NAME


class LogEntryRequest(BaseModel):
    run_id: str
    prompt_id: str
    category: str
    prompt: str
    tokenWire: dict
    baseline: dict


class GenerateReportRequest(BaseModel):
    run_id: str

class LoadModelRequest(BaseModel):
    model_id: str

# --- Endpoints ---

@router.get("/datasets")
async def get_datasets():
    """Returns all available benchmark datasets and their metadata."""
    datasets = list_datasets()
    return {"datasets": datasets}


@router.get("/datasets/{dataset_id}/prompts")
async def get_prompts(dataset_id: str):
    """Returns all prompts for a specific dataset."""
    try:
        prompts = get_dataset_prompts(dataset_id)
        return {"dataset_id": dataset_id, "prompts": prompts}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/start")
async def start_run(req: StartRunRequest):
    """Initialize a new research run with metadata."""
    model = req.model or settings.LLM_MODEL_NAME
    try:
        metadata = initialize_run(req.run_id, req.dataset_id, model)
        return {"status": "initialized", "metadata": metadata}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to initialize run: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/log")
async def log_result(req: LogEntryRequest):
    """Append a single prompt's benchmark results to the run log."""
    try:
        append_log(req.run_id, req.model_dump())
        return {"status": "logged", "prompt_id": req.prompt_id}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to log result: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate")
async def generate(req: GenerateReportRequest):
    """Aggregate logs and generate the final research report."""
    try:
        summary = generate_report(req.run_id)
        return {"status": "generated", "summary": summary}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to generate report: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/models")
async def get_models():
    """Returns a list of available AI models."""
    try:
        models = ModelManager.get_available_models()
        return {"models": models}
    except Exception as e:
        logger.error(f"Failed to clear cache: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/model/load")
async def load_model(req: LoadModelRequest):
    """Load a specific model."""
    try:
        ModelManager.load_model(req.model_id)
        return {"status": "success", "message": f"Model {req.model_id} loaded successfully."}
    except Exception as e:
        logger.error(f"Failed to load model {req.model_id}: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@router.post("/cache/clear")
async def clear_cache():
    """Clear the KV cache."""
    try:
        ModelManager.reset_cache()
        return {"status": "success", "message": "Cache cleared."}
    except Exception as e:
        logger.error(f"Failed to clear cache: {e}")
        raise HTTPException(status_code=500, detail=str(e))
