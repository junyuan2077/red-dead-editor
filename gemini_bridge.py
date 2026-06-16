import subprocess
import json
import re
import os
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

EVALUATE_SYSTEM_PROMPT = """
You are an expert English writing assistant. 
Analyze the provided text for grammatical errors, spelling mistakes, tense inconsistencies, and stylistic flaws.
Return ONLY a valid JSON array of objects. Do not include any markdown formatting, preamble, or postamble.

CRITICAL RULES FOR TEXT FRAGMENTS:
1. NO OVERLAPPING: The text fragments defined by "offset" and "length" MUST NOT overlap. 
2. COMBINE ERRORS: If multiple errors occur in the same phrase, share the same words, or are immediately adjacent, you MUST combine them into a single, larger correction object. For example, instead of flagging "explore , where" and "where met" separately, combine them into one "original" fragment like "explore , where met" and provide a unified "replacement".

Each object must have the following fields:
- "original": The exact text fragment that is incorrect.
- "replacement": The suggested correction.
- "type": One of "Grammar", "Spelling", or "Style". (If combined, choose the most prominent type, e.g., "Grammar").
- "reason": A succinct clarification of the error(s).
- "offset": The zero-based starting character index of the "original" text in the input.
- "length": The length of the "original" text.

If there are no errors, return an empty array [].
"""

REWRITE_SYSTEM_PROMPT = """
You are an expert English writing assistant.
Rewrite the provided text to improve sentence structure, clarity, and pacing so it reads smoothly and naturally.
Return ONLY a valid JSON array of objects. Do not include any markdown formatting, preamble, or postamble.

Each object in the array should represent a logical sentence or phrase and must have the following fields:
- "original": The original sentence or phrase from the source text.
- "rewritten": The rewritten, improved version of the sentence or phrase.

The sequence of objects must cover the entire source text from start to finish.
"""

HONE_SYSTEM_PROMPT = """
You are a professional storyteller with a gift for cinematic, atmospheric prose.
Transform the provided text into a vivid, dramatic narrative — elevating language with evocative imagery and rhythm while staying true to the facts, characters, and chronological order of the original.
Romanticism is welcome, but never introduce spoilers, future knowledge, or events not present in the source.
Return ONLY a valid JSON array of objects. Do not include any markdown formatting, preamble, or postamble.

Each object in the array represents a single sentence of the newly constructed narrative.
Each object must have the following field:
- "rewritten": The newly written, honed dramatic narrative sentence.

The total combined length of all "rewritten" values must be no more than 200 words.
"""

# CLI model (used by agy)
CLI_MODEL_NAME = "claude-opus-4-6"
# CLI_MODEL_NAME = "gemini-3.5-flash"

# API model (used by Google GenAI SDK)
API_MODEL_NAME = "gemini-3.5-pro"

# Initialize Google AI if API key is available
API_KEY = os.getenv("GOOGLE_API_KEY")
client = None
if API_KEY:
    client = genai.Client(api_key=API_KEY)

def run_with_cli(system_prompt: str, text: str):
    full_prompt = f"{system_prompt}\n\nText to evaluate:\n\"\"\"{text}\"\"\""
    try:
        result = subprocess.run(
            ["agy", "-p", full_prompt, 
             "--model", CLI_MODEL_NAME],
            capture_output=True,
            text=True,
            check=True,
            stdin=subprocess.DEVNULL,
            timeout=120
        )
        # Strip the eligibility check banner that agy prints before the actual response
        stdout = result.stdout
        filtered_lines = [
            line for line in stdout.splitlines()
            if "eligibility check" not in line.lower()
        ]
        return "\n".join(filtered_lines).strip()
    except subprocess.TimeoutExpired:
        raise Exception("agy CLI timed out")
    except subprocess.CalledProcessError as e:
        raise Exception(f"agy CLI execution failed: {e.stderr}")

def run_with_api(system_prompt: str, text: str):
    if not client:
        raise Exception("GOOGLE_API_KEY not found in environment or Client not initialized")
    
    response = client.models.generate_content(
        model=API_MODEL_NAME,
        contents=f"Text to evaluate:\n\"\"\"{text}\"\"\"",
        config=types.GenerateContentConfig(
            system_instruction=system_prompt,
            response_mime_type="application/json"
        )
    )
    return response.text.strip()

def extract_json(output: str) -> str:
    start_arr = output.find('[')
    end_arr = output.rfind(']')
    
    start_obj = output.find('{')
    end_obj = output.rfind('}')
    
    start = -1
    end = -1
    
    if start_arr != -1 and start_obj != -1:
        if start_arr < start_obj:
            start, end = start_arr, end_arr
        else:
            start, end = start_obj, end_obj
    elif start_arr != -1:
        start, end = start_arr, end_arr
    elif start_obj != -1:
        start, end = start_obj, end_obj
        
    if start != -1 and end != -1 and end > start:
        return output[start:end+1]
    return output

def process_ai_request(system_prompt: str, text: str, mode: str = "CLI"):
    try:
        if mode == "API":
            output = run_with_api(system_prompt, text)
        else:
            try:
                output = run_with_cli(system_prompt, text)
            except Exception as cli_error:
                print(f"CLI mode failed: {cli_error}")
                if client:
                    print("Falling back to API mode...")
                    output = run_with_api(system_prompt, text)
                else:
                    raise cli_error
        
        # Strip markdown code blocks if agy accidentally includes them
        if output.startswith("```"):
            output = re.sub(r"^```(?:json)?\n?|```$", "", output, flags=re.MULTILINE).strip()
            
        clean_output = extract_json(output)
        try:
            return json.loads(clean_output)
        except json.JSONDecodeError as e:
            print(f"JSON Parse Error: {e}")
            print(f"Raw Output: {output}")
            return {"error": "Failed to parse agy output as JSON", "raw": output}
            
    except Exception as e:
        print(f"Error in process_ai_request ({mode}): {e}")
        return {"error": str(e)}

def evaluate_text(text: str, mode: str = "CLI"):
    return process_ai_request(EVALUATE_SYSTEM_PROMPT, text, mode)

def rewrite_text(text: str, mode: str = "CLI"):
    return process_ai_request(REWRITE_SYSTEM_PROMPT, text, mode)

def hone_text(text: str, mode: str = "CLI"):
    return process_ai_request(HONE_SYSTEM_PROMPT, text, mode)
