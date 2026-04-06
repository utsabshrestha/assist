import os
import json
import shutil
import re
from typing import List, Dict, Any, Optional
from llama_cpp import Llama

class FileSystemTools:
    """Read and write tools for the agent with safety boundaries."""
    
    @staticmethod
    def list_files(path: str = ".") -> str:
        """Returns a formatted list of files and directories in the given path."""
        try:
            items = os.listdir(path)
            details = []
            for item in items:
                # hide hidden files to reduce noise
                if item.startswith('.'): continue
                full_path = os.path.join(path, item)
                is_dir = os.path.isdir(full_path)
                details.append(f"{'[DIR]' if is_dir else '[FILE]'} {item}")
            if not details:
                return "Directory is empty."
            return "\n".join(details)
        except Exception as e:
            return f"Error reading directory '{path}': {e}"

    @staticmethod
    def create_folder(path: str) -> str:
        try:
            os.makedirs(path, exist_ok=True)
            return f"Success: Folder '{path}' is ready."
        except Exception as e:
            return f"Error creating folder '{path}': {e}"

    @staticmethod
    def move_file(source: str, destination: str) -> str:
        try:
            # Ensure destination directory exists
            dest_dir = os.path.dirname(destination)
            if dest_dir and not os.path.exists(dest_dir):
                os.makedirs(dest_dir, exist_ok=True)
                
            shutil.move(source, destination)
            return f"Success: Moved '{source}' to '{destination}'."
        except Exception as e:
            return f"Error moving '{source}': {e}"


class Agent:
    def __init__(self, model_path: str = "Qwen3.5-9B-Q5_K_M.gguf"):
        print("[System] Initializing model, this might take a moment...")
        self.llm = Llama(
            model_path=model_path,
            n_gpu_layers=-1, 
            n_ctx=16384,     
            verbose=False # Set to False for a cleaner CLI experience
        )
        self.messages: List[Dict[str, str]] = []
        self._setup_system_prompt()
        self.tools = FileSystemTools()
        
        # Tools that require user confirmation (Human-in-the-loop)
        self.dangerous_actions = ["create_folder", "move_file"]

    def _setup_system_prompt(self):
        prompt = """You are an advanced, cautious File Organization AI Agent.
Your process must strictly follow these phases:
1. PHASE 1: ANALYSIS. When asked to organize a folder, IMMEDIATELY call `list_files` to understand the workspace.
2. PHASE 2: PROPOSE. Analyze what you found. Propose 2-3 creative options on how to organize the files (e.g., by date, file type, project name). Ask the user which option they prefer and wait for their answer. Do NOT move files yet.
3. PHASE 3: EXECUTE. Once the user selects an option, execute the plan using `create_folder` and `move_file`. 

You have access to the following tools:
- {"action": "list_files", "path": "string"}
- {"action": "create_folder", "path": "string"}
- {"action": "move_file", "source": "string", "destination": "string"}

When you want to use a tool, you MUST output a raw JSON block like this and NOTHING ELSE:
```json
{"action": "tool_name", "path": "/example/path"}
```
If you are talking to the user, asking questions, or proposing options, just output plain text (NO JSON).
"""
        self.messages = [{"role": "system", "content": prompt}]

    def text_to_json(self, response_text: str) -> Optional[Dict[str, Any]]:
        """Extract JSON tool call from model output if it exists."""
        # Try to find a JSON block in markdown
        match = re.search(r'```json\s*(.*?)\s*```', response_text, re.DOTALL)
        if match:
            try:
                return json.loads(match.group(1))
            except json.JSONDecodeError:
                pass
                
        # Fallback: attempt to parse the entire string if it looks like JSON
        text = response_text.strip()
        if text.startswith("{") and text.endswith("}"):
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                pass
        return None

    def execute_tool(self, action: str, kwargs: Dict[str, Any]) -> str:
        """Executes a tool, prompting the user for permission if it's a dangerous action."""
        if action == "list_files":
            return self.tools.list_files(kwargs.get("path", "."))
            
        elif action in self.dangerous_actions:
            # Human in the loop permission check
            print(f"\n⚠️  [PERMISSION REQUIRED] Agent wants to execute: \033[93m{action}\033[0m with arguments {kwargs}")
            while True:
                choice = input("Do you allow this action? (y/n): ").strip().lower()
                if choice in ['y', 'yes']:
                    if action == "create_folder":
                        return self.tools.create_folder(kwargs.get("path"))
                    elif action == "move_file":
                        return self.tools.move_file(kwargs.get("source"), kwargs.get("destination"))
                elif choice in ['n', 'no']:
                    print("Action denied by user.")
                    return f"Action '{action}' was denied by the user due to safety concerns. Do not attempt this specific layout without asking."
                else:
                    print("Please answer 'y' or 'n'.")
        else:
            return f"Error: Tool '{action}' is not recognized."

    def chat_loop(self):
        print("\n\033[92m=== File Organization Agent ===\033[0m")
        print("Agent is ready. Describe how you want to manage your files (e.g., 'Organize this folder').")
        print("Type 'exit' to quit.\n")
        
        while True:
            try:
                user_input = input("\033[94mUser:\033[0m ")
                if user_input.lower() in ['exit', 'quit']:
                    break
                    
                self.messages.append({"role": "user", "content": user_input})
                
                # Agent action loop to handle multiple autonomous tool calls before responding to user
                while True:
                    print("\033[96mAgent:\033[0m ", end="", flush=True)
                    response_obj = self.llm.create_chat_completion(
                        messages=self.messages,
                        max_tokens=612,
                        temperature=0.3, # Low temp for reliable reasoning/JSON
                        stream=True # Stream tokens as they are generated
                    )
                    
                    reply = ""
                    for chunk in response_obj:
                        delta = chunk['choices'][0]['delta']
                        if 'content' in delta:
                            content = delta['content']
                            reply += content
                            print(content, end="", flush=True)
                    print("\n")
                    
                    reply = reply.strip()
                    self.messages.append({"role": "assistant", "content": reply})
                    
                    tool_call = self.text_to_json(reply)
                    
                    if tool_call and "action" in tool_call:
                        # Agent chose to use a tool
                        action = tool_call["action"]
                        # The parameters are flat in the JSON, not nested in kwargs
                        
                        if action == "list_files":
                             print(f"\033[95m[Agent Action]\033[0m Reading files in directory: {tool_call.get('path', '.')}")
                             
                        tool_result = self.execute_tool(action, tool_call)
                        
                        # Feeds result back to agent as a system observation
                        self.messages.append({
                            "role": "user", 
                            "content": f"[Tool Output for '{action}']: {tool_result}"
                        })
                        # Continue the while loop so the agent can react to the tool output
                    else:
                        # Agent is just talking to the human (proposing options, asking questions)
                        # We already printed the reply during the streaming loop above
                        break # Break out of inner loop to get human input
                        
            except KeyboardInterrupt:
                print("\nExiting agent.")
                break
            except Exception as e:
                print(f"\nAn error occurred: {e}")
                self.messages.append({"role": "user", "content": f"System Error occurred: {e}. Please recover and continue."})

if __name__ == "__main__":
    agent = Agent()
    agent.chat_loop()
