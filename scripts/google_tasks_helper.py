import os
import json
import requests

def refresh_token():
    token_path = os.path.expanduser('~/.gmail-mcp/credentials.json') # Using Gmail/Tasks specific token if available
    keys_path = os.path.expanduser('~/.config/google-drive-mcp/gcp-oauth.keys.json')
    
    if not os.path.exists(token_path) or not os.path.exists(keys_path):
        # Fallback to the main token if the gmail-mcp one doesn't exist
        token_path = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')
        if not os.path.exists(token_path):
            return None
        
    with open(token_path, 'r') as f:
        tokens = json.load(f)
    with open(keys_path, 'r') as f:
        keys = json.load(f).get('installed', {})
        
    refresh_token = tokens.get('refresh_token')
    client_id = keys.get('client_id')
    client_secret = keys.get('client_secret')
    
    if not refresh_token or not client_id or not client_secret:
        return None
        
    url = "https://oauth2.googleapis.com/token"
    data = {
        'client_id': client_id,
        'client_secret': client_secret,
        'refresh_token': refresh_token,
        'grant_type': 'refresh_token'
    }
    
    response = requests.post(url, data=data)
    if response.status_code == 200:
        new_tokens = response.json()
        tokens['access_token'] = new_tokens['access_token']
        with open(token_path, 'w') as f:
            json.dump(tokens, f, indent=2)
        return tokens['access_token']
    return None

def create_task(title, notes):
    # Try Gmail token first, then Drive token
    token = None
    gmail_token_path = os.path.expanduser('~/.gmail-mcp/credentials.json')
    if os.path.exists(gmail_token_path):
        with open(gmail_token_path, 'r') as f:
            token = json.load(f).get('access_token')

    def try_post(t):
        url = "https://tasks.googleapis.com/tasks/v1/lists/@default/tasks"
        headers = {
            "Authorization": f"Bearer {t}",
            "Content-Type": "application/json"
        }
        task = {
            'title': title,
            'notes': notes
        }
        return requests.post(url, headers=headers, json=event_json if 'event_json' in locals() else task)

    response = try_post(token) if token else type('obj', (object,), {'status_code': 401})()
    
    if response.status_code == 401:
        token = refresh_token()
        if token:
            response = try_post(token)

    if response.status_code == 200:
        print(f"Successfully created task: {title}")
    else:
        print(f"Failed to create task. Status code: {response.status_code}")

if __name__ == "__main__":
    create_task("Review Booking Pitch Emails", "Review and finalize the Tier 1, 2, and 3 pitch emails in gdrive/JoshMariaMusic/ folder.")
    create_task("Send Outreach Emails", "Send finalized pitch emails to Tier 1 venues (The Spot on Kirk, The Exchange, Floyd Country Store).")
