import asyncio
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
import json
import struct
from fastapi.middleware.cors import CORSMiddleware
from app.core.config import settings
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

from contextlib import asynccontextmanager
from .services.model_manager import ModelManager
from .services.model_manager import llama_tokenWire_generator, llama_baseline_generator

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("System Boot: Pre-loading dual Llama instances (baseline + tokenWire)...")
    # Load both dedicated instances up front to eliminate cold-start TTFT bias
    ModelManager.load_model(ModelManager._current_model_name)
    logger.info("System Ready: Both Llama instances bound to memory — KV caches are fully independent.")
    yield
    logger.info("System Shutdown: Releasing neural weights...")

app = FastAPI(title="TokenWire Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_origin_regex=".*",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount Research API
from .api.research import router as research_router
app.include_router(research_router)
@app.websocket("/ws/stream")
async def websocket_stream(websocket: WebSocket):
    await websocket.accept()
    session_task = None

    try:
        while True:
            # Receive control message from client (using standard JSON text)
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                logger.error("Invalid JSON control message")
                continue
            
            if msg.get("signal") == "START_STREAM":
                prompt = msg.get("prompt", "")
                logger.info(f"START_STREAM received. Using model: {settings.LLM_MODEL_NAME}")
                
                # Iterate generator directly on the connection thread for minimum TTFT
                try:
                    async for tokens_batch in llama_tokenWire_generator(prompt):
                        # Pack tokens into binary frame
                        fmt = "<" + "I" * len(tokens_batch)
                        packet = struct.pack(fmt, *tokens_batch)
                        await websocket.send_bytes(packet)
                    
                    logger.info("TokenWire stream completed")
                    await websocket.close()
                    break # end loop after done
                except Exception as e:
                    logger.error(f"TokenWire stream error: {e}")
                    break
                
            elif msg.get("signal") == "STOP_STREAM":
                logger.info("STOP_STREAM")
                if session_task:
                    session_task.cancel()
                break
                
    except WebSocketDisconnect:
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
    finally:
        if session_task:
            session_task.cancel()

@app.websocket("/ws/baseline")
async def websocket_baseline_stream(websocket: WebSocket):
    await websocket.accept()
    try:
        while True:
            prompt = await websocket.receive_text()
            logger.info(f"BASELINE_STREAM received prompt: {prompt}")
            
            async for token_text in llama_baseline_generator(prompt):
                if not token_text: continue
                payload = {
                    "model": settings.LLM_MODEL_NAME,
                    "response": token_text,
                    "done": False
                }
                await websocket.send_json(payload)
                
            await websocket.send_json({"model": settings.LLM_MODEL_NAME, "response": "", "done": True})
    except WebSocketDisconnect:
        logger.info("Baseline client disconnected")
    except Exception as e:
        logger.error(f"Baseline stream error: {e}")
