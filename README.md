![banner(1)](https://github.com/user-attachments/assets/e9a7241f-ec96-4a96-988c-3ac5fce6e70e)

# Minecraft Bot Client

A desktop application for managing Minecraft bots with an intuitive graphical interface. Built with Electron and Node.js.

Actual version 5.2.0
BlastHack thread: https://www.blast.hk/threads/233178/

## Features

### Commands
- `!help` - Show list of all available commands
- `!fish` - Start automatic fishing
- `!unfish` - Stop automatic fishing
- `!getip` - Get your IP address information
- `!saveacc` - Save account data to file
- `!entities` - Show list of nearby entities
- `!hit <player> [left/right]` - Hit/click on player (left by default)
- `!walk <player>` - Walk to specified player
- `!follow <player>` - Follow specified player
- `!stopfollow` - Stop following
- `!krug` - Walk in circles
- `!stopkrug` - Stop walking in circles
- `!inventory` - Show inventory contents
- `!drop <slot> [amount]` - Drop items from specified slot
- `!drop all` - Drop all items and armor
- `!harvest <crop_type>` - Start harvesting crops
  - Available types: wheat, carrot, potato, beetroot, melon, pumpkin, sugarcane, cactus
- `!stopharvest` - Stop harvesting

### Core Functionality
- Connect/disconnect bot to Minecraft servers
- Command console with history
- Real-time bot status monitoring
- Customizable server settings
- Dark/Light theme support

### Farming Features
- Automated fishing
- Crop harvesting system supporting:
  - Wheat
  - Carrots
  - Potatoes
  - Beetroot
  - Melons
  - Pumpkins
  - Sugar Cane
  - Cactus

### Bot Management
- Real-time health/hunger/armor monitoring
- Inventory management
- Item dropping functionality
- Uptime tracking
- Activity status display

### Captcha Handling
- Captcha image capture and storage
- Built-in captcha viewer
- Captcha history navigation
- Clear captcha history option

### Logging System
- Automatic log creation for each bot
- Log format: {BotName}_{Date}_log.txt
- Logs stored in 'logs' folder
- Captures:
  - Chat messages
  - Commands
  - Connection events
  - Errors
