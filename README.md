# 🕵️‍♂️ SteamReveal 🕵️‍♀️

---

## - :wave: Introduction

This repository contains the code for **SteamReveal**, an advanced OSINT (Open Source
Intelligence) tool developed with **Next.js** and **TypeScript**. SteamReveal is designed
for the **Steam** community at large, allowing users to uncover hidden profile data,
such as a player's **possible location** and their **Close Friends** network. For
Counter-Strike (CS) players, it also offers a specialized **Cheater Probability** analysis.

<sub>Figure 1</sub> ![homepage](https://i.imgur.com/MbyoAeM.png)

This repository is divided into parts:

- Features
- Technologies Used
- How it Works
- Privacy
- Contact

---

## - :video_game: Features

- **Geographic Triangulation (General Steam):** Discovers any player's most likely location by analyzing the public location data of their closest social circle (mutual friend density).
- **Social Graph Analysis (General Steam):** Maps the top 20 "Close Friends" based on mutual connection weight rather than just a simple friends list.
- **AI Cheater Probability (CS Exclusive):** Calculates the likelihood of a user being a cheater using a machine learning model that analyzes profile comments sentiment, friend ban proximity, account investment, and specific **Counter-Strike** stats.
- **User-Friendly Interface:** Developed with React and Framer Motion to ensure a fluid, modern, and responsive experience.
- **Multilingual Support:** Full support for English and Portuguese via `next-intl`.

To access it, click on the link: [SteamReveal](https://steam-reveal.vercel.app/)

---

## 👩‍💻 Technologies Used

In the development of SteamReveal, we used a modern stack to ensure performance and intelligence:

- **TypeScript:** For static typing and code reliability.
- **React & Next.js 14:** Core framework for server-side rendering and routing.
- **Tailwind CSS & Framer Motion:** For utility-first styling and smooth UI animations.
- **SteamAPI & Cheerio:** Used to collect official data and scrape public profile comments for sentiment analysis.
- **AI/ML Backend:** Integration with a Flask-based prediction model for CS cheater probability.
- **next-intl:** Internationalization for global users.

---

## - :grey_question: How it Works

1. **Input:** Enter a Steam URL, Custom ID, or SteamID64.
2. **Data Collection:** The system fetches the target's friends and public profile data. If the target is a CS player, it also collects game-specific stats and comments.
3. **Triangulation:** It identifies "Close Friends" by mutual count and aggregates their public locations to find the target's geographic hub.
4. **AI Prediction (for CS):** A set of features (ban history, comment sentiment, account age/value) is sent to a machine learning model to estimate cheater probability.
5. **Output:** Displays possible locations, the social graph, and the specialized Cheater Report when applicable.

<sub>Figure 2</sub> ![results](https://i.imgur.com/I6mJrAH.png)

---

## - :lock: Privacy

If you do not wish for your information to be publicly available, please visit
the [Steam Privacy section](https://steamcommunity.com/my/edit/settings) to
adjust your profile settings.

---

## - :telephone_receiver: Contact

**E-mail:** walterfelipeberchez@outlook.com
