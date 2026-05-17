import os, json, datetime, requests
def get_token():
    with open(os.path.expanduser('~/.config/google-drive-mcp/tokens.json'), 'r') as f:
        return json.load(f).get('access_token')
def add_event():
    token = get_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    start = datetime.datetime(2026, 5, 8, 15, 0, 0) # 11:00 AM EDT
    event = {
        'summary': 'Follow up: Mac n Bob\'s (Bobby Reynolds)',
        'description': 'Left message for Bobby Reynolds on 5/7. Call back if no word by today. Phone: 540-389-5999.',
        'start': {'dateTime': start.isoformat() + 'Z', 'timeZone': 'UTC'},
        'end': {'dateTime': (start + datetime.timedelta(minutes=30)).isoformat() + 'Z', 'timeZone': 'UTC'}
    }
    requests.post("https://www.googleapis.com/calendar/v3/calendars/primary/events", headers=headers, json=event)
add_event()
