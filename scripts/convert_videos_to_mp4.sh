#!/bin/bash
TARGET_DIR="/home/joshua/Dropbox/joshandmariamusic/JoshMaria_videos-2026"

if [ ! -d "$TARGET_DIR" ]; then
    echo "Error: Directory $TARGET_DIR does not exist."
    exit 1
fi

cd "$TARGET_DIR"

for file in *.MOV *.mov; do
    # Skip if no files found
    [ -e "$file" ] || continue
    
    filename="${file%.*}"
    echo "Converting $file to ${filename}.mp4..."
    
    # Use standard web-compatible settings
    # -c:v libx264: H.264 video codec
    # -crf 23: Good quality/size balance
    # -pix_fmt yuv420p: Required for high compatibility (QuickTime/iOS)
    # -c:a aac: AAC audio codec
    # -movflags +faststart: Moves metadata to front for faster web playback
    ffmpeg -i "$file" -c:v libx264 -crf 23 -pix_fmt yuv420p -c:a aac -ac 2 -b:a 128k -movflags +faststart "${filename}.mp4" -y
    
    if [ $? -eq 0 ]; then
        echo "Successfully converted $file"
    else
        echo "Error converting $file"
    fi
done
