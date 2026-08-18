import importlib.metadata


def test_real_document_intelligence_engines_are_installed() -> None:
    assert importlib.metadata.version("paddleocr")
    assert importlib.metadata.version("docling")


def test_ollama_adapter_defaults_to_the_recommended_qwen_vision_profile() -> None:
    from umojaflowos_document_intelligence.ollama_adapter import OllamaVisualAdapter

    assert OllamaVisualAdapter().model == "qwen3-vl:8b"
