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
        # Update tokens.json
        with open(token_path, 'w') as f:
            json.dump(tokens, f, indent=2)
        return tokens['access_token']
    else:
        print(f"Failed to refresh token: {response.status_code}")
        print(response.text)
        return None

def get_access_token():
    token_path = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')
    if not os.path.exists(token_path):
        return None
    with open(token_path, 'r') as f:
        data = json.load(f)
        return data.get('access_token')

def create_calendar_event(summary, description, start_time, end_time):
    token = get_access_token()
    
    def try_post(t):
        url = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
        headers = {
            "Authorization": f"Bearer {t}",
            "Content-Type": "application/json"
        }
        event = {
            'summary': summary,
            'description': description,
            'start': {'dateTime': start_time.isoformat() + 'Z', 'timeZone': 'UTC'},
            'end': {'dateTime': end_time.isoformat() + 'Z', 'timeZone': 'UTC'},
            'reminders': {'useDefault': True}
        }
        return requests.post(url, headers=headers, json=event)

    response = try_post(token)
    if response.status_code == 401:
        print("Token expired, refreshing...")
        token = refresh_token()
        if token:
            response = try_post(token)

    if response.status_code == 200:
        print(f"Successfully created event: {summary}")
    else:
        print(f"Failed to create event. Status code: {response.status_code}")
        print(response.text)

if __name__ == "__main__":
    tomorrow = datetime.datetime(2026, 5, 7, 17, 0, 0) # 1:00 PM EDT
    
    calls = [
        ("Call: Parkway Brewing (Salem)", "Warm lead. Contact: Lezlie Snyder. Phone: 540-404-9810. Ask for June 20, 21, 27, or 28."),
        ("Call: Valhalla Vineyard (Roanoke)", "Warm lead. Contact: Lucy Buckner Tkachenko. Phone: 540-529-0996 (Winery: 540-725-9463). Ask for June 20, 21, 27, or 28."),
        ("Call: Villa Appalaccia (Floyd)", "Warm lead. Contact: Heyward S. Phone: 540-593-3100. Ask for late June dates."),
        ("Call: Beliveau Farm (Blacksburg)", "Warm lead. Contact: Joyce Beliveau. Phone: 540-961-2102. Ask for late June dates."),
        ("Call: AmRhein's Winery (Bent Mt)", "Warm lead. Contact: Jackie. Phone: 540-929-4632. Ask for late June dates."),
        ("Call: Mac n Bob's (Salem)", "Warm lead. Phone: 540-389-5999. Local Salem favorite."),
        ("Call: Tequila's (Martinsville)", "Warm lead (played Oct 2025). Phone: 276-336-3727."),
        ("Call: Two Sisters Tap Room (Altavista)", "Cold Call. Phone: (434) 369-7476. Use Lynchburg/Rustburg son opener!"),
        ("Call: Grinnin' Bear Tavern (Rustburg)", "Cold Call. Phone: (434) 993-6205. Use Lynchburg/Rustburg son opener!"),
        ("Call: The Yard on 5th (Lynchburg)", "Cold Call. Phone: (434) 849-7936. Use Lynchburg/Rustburg son opener!"),
        ("Call: Apocalypse Ale Works (Forest)", "Cold Call. Phone: (434) 258-8761. Use Lynchburg/Rustburg son opener!"),
        ("Call: Blue Mountain Barrel House (Arrington)", "Cold Call. Phone: (434) 263-4002. Use Lynchburg/Rustburg son opener!")
    ]

    for i, (summary, desc) in enumerate(calls):
        start = tomorrow + datetime.timedelta(minutes=i*30)
        end = start + datetime.timedelta(minutes=20)
        create_calendar_event(summary, desc, start, end)
