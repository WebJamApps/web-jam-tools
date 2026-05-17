import os
import json
import datetime
import requests

def refresh_token():
    token_path = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')
    keys_path = os.path.expanduser('~/.config/google-drive-mcp/gcp-oauth.keys.json')
    if not os.path.exists(token_path) or not os.path.exists(keys_path):
        return None
    with open(token_path, 'r') as f:
        tokens = json.load(f)
    with open(keys_path, 'r') as f:
        keys = json.load(f).get('installed', {})
    refresh_token_val = tokens.get('refresh_token')
    client_id = keys.get('client_id')
    client_secret = keys.get('client_secret')
    url = "https://oauth2.googleapis.com/token"
    data = {'client_id': client_id, 'client_secret': client_secret, 'refresh_token': refresh_token_val, 'grant_type': 'refresh_token'}
    response = requests.post(url, data=data)
    if response.status_code == 200:
        new_tokens = response.json()
        tokens['access_token'] = new_tokens['access_token']
        with open(token_path, 'w') as f:
            json.dump(tokens, f, indent=2)
        return tokens['access_token']
    return None

def get_access_token():
    token_path = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')
    with open(token_path, 'r') as f:
        return json.load(f).get('access_token')

def create_event():
    token = get_access_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    
    # Tonight, May 6, 2026 at 9:00 PM EDT (UTC+4 = 01:00 AM May 7)
    start = datetime.datetime(2026, 5, 7, 1, 0, 0) 
    event = {
        'summary': 'MariaParty: Garage Freezer Inventory',
        'description': 'Take inventory of meat for the party (Pork, Wings, Drums, Sausages, Burgers). Weigh the primary items.',
        'start': {'dateTime': start.isoformat() + 'Z', 'timeZone': 'UTC'},
        'end': {'dateTime': (start + datetime.timedelta(hours=1)).isoformat() + 'Z', 'timeZone': 'UTC'},
        'reminders': {'useDefault': True}
    }
    
    response = requests.post("https://www.googleapis.com/calendar/v3/calendars/primary/events", headers=headers, json=event)
    if response.status_code == 401:
        token = refresh_token()
        headers["Authorization"] = f"Bearer {token}"
        response = requests.post("https://www.googleapis.com/calendar/v3/calendars/primary/events", headers=headers, json=event)
    
    if response.status_code == 200:
        print("Successfully scheduled freezer inventory.")
    else:
        print(f"Failed to schedule: {response.status_code}")

if __name__ == "__main__":
    create_event()
