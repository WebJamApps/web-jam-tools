import os
import json
import datetime
import requests

def get_access_token():
    token_path = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')
    with open(token_path, 'r') as f:
        return json.load(f).get('access_token')

def check_conflicts(start_date, end_date):
    token = get_access_token()
    headers = {"Authorization": f"Bearer {token}"}
    
    time_min = start_date.isoformat() + 'Z'
    time_max = end_date.isoformat() + 'Z'
    
    url = f"https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin={time_min}&timeMax={time_max}&singleEvents=true"
    
    response = requests.get(url, headers=headers)
    if response.status_code == 200:
        events = response.json().get('items', [])
        if not events:
            print("No conflicts found for this period.")
        for event in events:
            start = event['start'].get('dateTime', event['start'].get('date'))
            print(f"CONFLICT: {event.get('summary')} at {start}")
    else:
        print(f"Failed to check calendar: {response.status_code}")

if __name__ == "__main__":
    # Checking June 26-28, 2026
    start = datetime.datetime(2026, 6, 26, 0, 0, 0)
    end = datetime.datetime(2026, 6, 29, 0, 0, 0)
    check_conflicts(start, end)
