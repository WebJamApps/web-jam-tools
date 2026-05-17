import os, json, datetime, requests
def get_token():
    with open(os.path.expanduser('~/.config/google-drive-mcp/tokens.json'), 'r') as f:
        return json.load(f).get('access_token')
def cancel_event():
    token = get_token()
    headers = {"Authorization": f"Bearer {token}"}
    now = datetime.datetime(2026, 5, 7, 0, 0, 0).isoformat() + 'Z'
    url = f"https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin={now}&q=AmRhein"
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        events = response.json().get('items', [])
        for event in events:
            if "AmRhein" in event.get('summary', ''):
                requests.delete(f"https://www.googleapis.com/calendar/v3/calendars/primary/events/{event['id']}", headers=headers)
                print(f"Canceled event: {event.get('summary')}")
cancel_event()
