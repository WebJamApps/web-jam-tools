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
    refresh_token = tokens.get('refresh_token')
    client_id = keys.get('client_id')
    client_secret = keys.get('client_secret')
    url = "https://oauth2.googleapis.com/token"
    data = {'client_id': client_id, 'client_secret': client_secret, 'refresh_token': refresh_token, 'grant_type': 'refresh_token'}
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

def cancel_event():
    token = get_access_token()
    headers = {"Authorization": f"Bearer {token}"}
    
    # List events for today
    now = datetime.datetime(2026, 5, 7, 0, 0, 0).isoformat() + 'Z'
    url = f"https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin={now}&q=Valhalla"
    
    response = requests.get(url, headers=headers)
    if response.status_code == 401:
        token = refresh_token()
        headers = {"Authorization": f"Bearer {token}"}
        response = requests.get(url, headers=headers)
    
    if response.status_code == 200:
        events = response.json().get('items', [])
        for event in events:
            if "Valhalla" in event.get('summary', ''):
                delete_url = f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event['id']}"
                del_resp = requests.delete(delete_url, headers=headers)
                if del_resp.status_code == 204:
                    print(f"Successfully canceled event: {event.get('summary')}")
    else:
        print(f"Failed to find event: {response.status_code}")

if __name__ == "__main__":
    cancel_event()
