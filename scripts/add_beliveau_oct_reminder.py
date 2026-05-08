import os, json, datetime, requests
def get_token():
    with open(os.path.expanduser('~/.config/google-drive-mcp/tokens.json'), 'r') as f:
        return json.load(f).get('access_token')
def add_event():
    token = get_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}
    start = datetime.datetime(2026, 10, 1, 14, 0, 0)
    event = {
        'summary': 'Follow up: Beliveau Farm Winery (2027 Booking)',
        'description': 'Joyce said to call back in Oct for 2027. Note: Winery was for sale in May 2026, check status.',
        'start': {'dateTime': start.isoformat() + 'Z', 'timeZone': 'UTC'},
        'end': {'dateTime': (start + datetime.timedelta(hours=1)).isoformat() + 'Z', 'timeZone': 'UTC'}
    }
    requests.post("https://www.googleapis.com/calendar/v3/calendars/primary/events", headers=headers, json=event)
add_event()
