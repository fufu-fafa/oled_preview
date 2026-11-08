(function () {
  const OLED = (globalThis.OLED = globalThis.OLED || {});
  OLED.EXAMPLES = [
    {
      name: 'Text and shapes',
      code: `#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64

Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, -1);

void setup() {
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.setTextColor(SSD1306_WHITE);
}

void showTitle() {
  display.clearDisplay();
  display.setTextSize(3);
  display.setCursor(28, 6);
  display.print("OLED");
  display.setTextSize(1);
  display.setCursor(13, 40);
  display.print("Runs your .ino code");
  display.drawFastHLine(13, 52, 102, SSD1306_WHITE);
  display.display();
}

void showShapes() {
  display.clearDisplay();
  display.drawRoundRect(4, 4, 36, 26, 6, SSD1306_WHITE);
  display.fillCircle(64, 17, 13, SSD1306_WHITE);
  display.fillTriangle(92, 30, 106, 4, 122, 30, SSD1306_WHITE);
  for (int i = 0; i < 12; i++) {
    display.drawLine(i * 11, 62, 60 + i * 2, 36, SSD1306_WHITE);
  }
  display.display();
}

void showBars() {
  display.clearDisplay();
  display.fillRect(0, 0, 128, 14, SSD1306_WHITE);
  display.setTextColor(SSD1306_BLACK);
  display.setCursor(4, 3);
  display.print("Levels");
  display.setTextColor(SSD1306_WHITE);
  for (int i = 0; i < 10; i++) {
    int h = 6 + (i * 37) % 40;
    display.fillRect(6 + i * 12, 63 - h, 8, h, SSD1306_WHITE);
  }
  display.display();
}

void loop() {
  showTitle();
  delay(1600);
  showShapes();
  delay(1600);
  showBars();
  delay(1600);
}
`,
    },
    {
      name: 'Bouncing ball',
      code: `#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

float x = 20, y = 12;
float vx = 1.7, vy = 0.6;
const int r = 5;
int bounces = 0;

void setup() {
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.setTextColor(SSD1306_WHITE);
}

void loop() {
  vy += 0.12;
  x += vx;
  y += vy;

  if (x < r || x > display.width() - r - 1) {
    vx = -vx;
    x = constrain(x, r, display.width() - r - 1);
    bounces++;
  }
  if (y > display.height() - r - 2) {
    vy = -vy * 0.96;
    y = display.height() - r - 2;
    bounces++;
  }

  display.clearDisplay();
  display.drawRect(0, 0, display.width(), display.height(), SSD1306_WHITE);
  display.fillCircle((int)x, (int)y, r, SSD1306_WHITE);
  display.setCursor(5, 4);
  display.print(bounces);
  display.display();
  delay(16);
}
`,
    },
    {
      name: 'Dial on A0',
      code: `#include <Adafruit_SSD1306.h>

Adafruit_SSD1306 display(128, 64, &Wire, -1);

const int cx = 64, cy = 58, radius = 44;

void setup() {
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
  display.setTextColor(SSD1306_WHITE);
}

void loop() {
  int raw = analogRead(A0);
  float temp = map(raw, 0, 1023, 0, 500) / 10.0;
  float angle = PI - (raw / 1023.0) * PI;

  display.clearDisplay();

  for (int d = 0; d <= 180; d += 15) {
    float a = radians(d);
    int len = d % 45 == 0 ? 6 : 3;
    display.drawLine(cx + cos(a) * radius, cy - sin(a) * radius,
                     cx + cos(a) * (radius - len), cy - sin(a) * (radius - len), SSD1306_WHITE);
  }
  display.drawLine(cx, cy, cx + cos(angle) * (radius - 9), cy - sin(angle) * (radius - 9), SSD1306_WHITE);
  display.fillCircle(cx, cy, 3, SSD1306_WHITE);

  char label[12];
  dtostrf(temp, 4, 1, label);
  strcat(label, " C");
  int16_t x1, y1;
  uint16_t w, h;
  display.getTextBounds(label, 0, 0, &x1, &y1, &w, &h);
  display.setCursor(cx - w / 2, 0);
  display.print(label);

  display.display();
  delay(30);
}
`,
    },
    {
      name: 'Menu with two buttons',
      code: `#include <Adafruit_SSD1306.h>

#define BTN_DOWN 2
#define BTN_SELECT 3

Adafruit_SSD1306 display(128, 64, &Wire, -1);

const char* items[] = { "Brightness", "Network", "Sensors", "About" };
const int itemCount = sizeof(items) / sizeof(items[0]);

int selected = 0;
int opened = -1;
bool lastDown = HIGH, lastSelect = HIGH;

void setup() {
  pinMode(BTN_DOWN, INPUT_PULLUP);
  pinMode(BTN_SELECT, INPUT_PULLUP);
  display.begin(SSD1306_SWITCHCAPVCC, 0x3C);
}

void drawMenu() {
  for (int i = 0; i < itemCount; i++) {
    int y = 4 + i * 15;
    if (i == selected) {
      display.fillRoundRect(2, y - 3, 124, 14, 3, SSD1306_WHITE);
      display.setTextColor(SSD1306_BLACK);
    } else {
      display.setTextColor(SSD1306_WHITE);
    }
    display.setCursor(8, y);
    display.print(items[i]);
  }
}

void drawDetail() {
  display.setTextColor(SSD1306_WHITE);
  display.setTextSize(2);
  display.setCursor(0, 8);
  display.println(items[opened]);
  display.setTextSize(1);
  display.setCursor(0, 50);
  display.print("Select to go back");
}

void loop() {
  bool down = digitalRead(BTN_DOWN);
  bool select = digitalRead(BTN_SELECT);

  if (down == LOW && lastDown == HIGH && opened < 0) {
    selected = (selected + 1) % itemCount;
  }
  if (select == LOW && lastSelect == HIGH) {
    opened = opened < 0 ? selected : -1;
  }
  lastDown = down;
  lastSelect = select;

  display.clearDisplay();
  display.setTextSize(1);
  if (opened < 0) drawMenu(); else drawDetail();
  display.display();
  delay(20);
}
`,
    },
    {
      name: 'U8g2 signal card',
      code: `#include <U8g2lib.h>
#include <Wire.h>

U8G2_SSD1306_128X64_NONAME_F_HW_I2C u8g2(U8G2_R0, U8X8_PIN_NONE);

int level = 0;

void setup() {
  u8g2.begin();
}

void drawBars(int x, int y, int strength) {
  for (int i = 0; i < 5; i++) {
    int h = 4 + i * 4;
    if (i < strength) {
      u8g2.drawBox(x + i * 7, y - h, 5, h);
    } else {
      u8g2.drawFrame(x + i * 7, y - h, 5, h);
    }
  }
}

void loop() {
  u8g2.clearBuffer();

  u8g2.setFont(u8g2_font_helvB12_tr);
  u8g2.drawStr(0, 15, "Garden");
  drawBars(90, 22, level);

  u8g2.drawHLine(0, 25, 128);

  u8g2.setFont(u8g2_font_6x10_tf);
  u8g2.drawStr(0, 40, "Soil");
  u8g2.drawRFrame(30, 32, 96, 10, 3);
  u8g2.drawRBox(32, 34, 20 + level * 15, 6, 2);

  u8g2.setCursor(0, 58);
  u8g2.print("Uptime ");
  u8g2.print(millis() / 1000);
  u8g2.print(" s");

  u8g2.sendBuffer();

  level = (level + 1) % 6;
  delay(700);
}
`,
    },
  ];
})();
