import os
import json
import datetime
import requests

def get_access_token():
    token_path = os.path.expanduser('~/.config/google-drive-mcp/tokens.json')
    if not os.path.exists(token_path):
        return None
    with open(token_path, 'r') as f:
        data = json.load(f)
        return data.get('access_token')

def create_calendar_event(summary, description, start_time, end_time):
    token = get_access_token()
    if not token:
        print("Error: Access token not found.")
        return

    url = "https://www.googleapis.com/calendar/v3/calendars/primary/events"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    event = {
        'summary': summary,
        'description': description,
        'start': {
            'dateTime': start_time.isoformat() + 'Z',
            'timeZone': 'UTC',
        },
        'end': {
            'dateTime': end_time.isoformat() + 'Z',
            'timeZone': 'UTC',
        },
        'reminders': {
            'useDefault': True
        }
    }

    response = requests.post(url, headers=headers, json=event)
    if response.status_code == 200:
        print(f"Successfully created event: {summary}")
    else:
        print(f"Failed to create event. Status code: {response.status_code}")
        print(response.text)

if __name__ == "__main__":
    # Tomorrow is May 7, 2026
    tomorrow = datetime.datetime(2026, 5, 7, 14, 0, 0) # 10:00 AM EDT (approx)
    
    calls = [
        ("Call: Stave & Cork (Salem)", "Warm lead. Recurring venue. Phone: 540-525-6430 (Susan). Ask for June 20, 21, 27, or 28."),
        ("Call: Floyd Country Store", "Top cold pick. Phone: 540-745-4563. Roots/Americana legendary. Ask for late June dates."),
        ("Call: Olde Salem Brewing", "Warm lead. Phone: 540-819-9083 (Ben Carroll). Walking distance from home.")
    ]

    for i, (summary, desc) in enumerate(calls):
        start = tomorrow + datetime.timedelta(hours=i)
        end = start + datetime.timedelta(minutes=30)
        create_calendar_event(summary, desc, start, end)
