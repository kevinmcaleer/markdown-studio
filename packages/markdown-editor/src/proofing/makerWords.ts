// Words every maker writes that the Hunspell lists don't know: boards, parts,
// tools and brands. Added to both languages' spellers, so they're never
// underlined and can come up as suggestions. Mixed-case names (WiFi, iPhone)
// and acronyms (GPIO) aren't checked at all, so they don't need to be here.

export const MAKER_WORDS = [
  // Wireless: "Wi-Fi" is read as two words.
  "Wifi", "wifi", "Wi", "Fi",
  // Boards and languages.
  "Pico", "Picos", "Arduinos", "MicroPython", "CircuitPython", "microcontroller", "microcontrollers",
  "devboard", "devboards", "Picozero", "Neopixel", "Neopixels", "neopixel", "neopixels",
  // Parts and wiring.
  "Dupont", "dupont", "perfboard", "stripboard", "multimeter", "multimeters", "heatsink", "heatsinks",
  "potentiometer", "potentiometers", "mosfet", "mosfets", "lipo", "pinout", "pinouts", "gearmotor",
  "gearmotors", "lidar", "crimper", "microSD",
  // Building and code.
  "hexapod", "hexapods", "cyberdeck", "cyberdecks", "desolder", "desoldering", "unsolder", "subfolder",
  "subfolders", "toolchain", "bootloader",
  // Makers' tools and shops.
  "Kevsrobots", "Thonny", "Tinkercad", "Onshape", "Wokwi", "Prusa", "Bambu", "Cura", "Github",
  "Pimoroni", "Adafruit", "SparkFun", "Qwiic", "Elegoo", "Freenove", "Waveshare", "Seeed", "Snakie",
];
