Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell -WindowStyle Hidden -Command ""Start-Process python -ArgumentList 'hider_bot.py' -WindowStyle Hidden; Start-Process python -ArgumentList 'convert_bot.py' -WindowStyle Hidden; Start-Process python -ArgumentList 'upload_bot.py' -WindowStyle Hidden""", 0, False
