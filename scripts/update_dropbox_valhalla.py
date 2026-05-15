import os
import pandas as pd
from datetime import datetime

file_path = '/home/joshua/Dropbox/joshandmariamusic/Gig Booking Worksheet 2025.xlsx'

if os.path.exists(file_path):
    # Read all sheets into a dictionary
    xls = pd.ExcelFile(file_path)
    sheets = {sheet_name: xls.parse(sheet_name) for sheet_name in xls.sheet_names}
    
    updated = False
    for sheet_name, df in sheets.items():
        # Look for columns that might contain the venue name
        venue_cols = [col for col in df.columns if any(keyword in str(col).lower() for keyword in ['venue', 'name'])]
        
        if venue_cols:
            for col in venue_cols:
                # Find rows containing "Valhalla"
                mask = df[col].astype(str).str.contains('Valhalla', case=False, na=False)
                if mask.any():
                    # Add "CLOSED 2025" to the comments column if it exists, or update the name
                    if 'comments' in [c.lower() for c in df.columns]:
                        comment_col = [c for c in df.columns if c.lower() == 'comments'][0]
                        df.loc[mask, comment_col] = df.loc[mask, comment_col].fillna('').astype(str) + " | PERMANENTLY CLOSED 2025"
                    else:
                        df.loc[mask, col] = df.loc[mask, col].astype(str) + " (CLOSED 2025)"
                    updated = True
    
    if updated:
        # Write back to the same path
        with pd.ExcelWriter(file_path, engine='openpyxl') as writer:
            for sheet_name, df in sheets.items():
                df.to_excel(writer, sheet_name=sheet_name, index=False)
        print(f"Successfully updated Dropbox spreadsheet: {file_path}")
    else:
        print("Valhalla not found in spreadsheet.")
else:
    print(f"Spreadsheet not found at: {file_path}")
