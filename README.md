# Driver Watch – AI-Powered Dashcam & Monitoring System

![Driver Watch UI](https://img.shields.io/badge/Status-v3.0.0--Enterprise-blue?style=for-the-badge)
![Tech](https://img.shields.io/badge/Powered%20By-TensorFlow.js-orange?style=for-the-badge)

**Watch Demo Video:** [YouTube Link](https://youtu.be/96vMgCNHZ2s)  
**Video Pitch Deck:** [Google Slides / PPT](https://docs.google.com/presentation/d/1Ks6NwwmCD-UJBYb8M-AVyBJ1ZPubEXDY/edit?usp=sharing&ouid=116063232986190540894&rtpof=true&sd=true)

---

## Project Overview

**Driver Watch** is an AI-powered fleet safety system designed to monitor drivers in real-time. It combines advanced computer vision with functional dashcam capabilities to protect lives and provide evidence for fleet managers. 

Originally envisioned as a hardware-software hybrid, this version delivers a sophisticated **Software Dashboard Simulation** that uses live camera input to detect fatigue, trigger emergency protocols, and record high-quality incident footage.

---

## Key Features

### 🛡️ Intelligent Monitoring
- **Real-time Fatigue Detection**: Powered by TensorFlow.js, the system identifies "Awake" vs "Drowsy" states with high precision.
- **Smart Alert Logic**: A 4-second "Drowsy Warning" phase with audible beeps before triggering the full alarm.
- **High-Intensity Siren**: A continuous, high-decibel "Henry Danger" style emergency siren (European variant) to ensure immediate driver arousal.
- **Emergency Dispatch Protocol**: Simulated 911/Dispatch sequence with automated TTS (Text-to-Speech) if the driver remains unresponsive.

### 📹 Dashcam & Evidence
- **Continuous Session Recording**: Automatically records the entire driving session in high-quality `.webm` format using the MediaRecorder API.
- **Instant Incident "Black Box"**: Automatically generates a downloadable **Incident Clip** the moment fatigue is detected, providing proof of the event without stopping the session.
- **REC Status Indicator**: A pulsating visual indicator on the dashcam feed confirms active recording.

### 📊 Enterprise Dashboard
- **Telemetry Stream**: Real-time FPS and resolution metrics.
- **Session Analysis**: Tracking uptime, drowsy time, and "Alertness Confidence Quotient" (CQ).
- **System Event Log**: A professional terminal-style log for all system actions and download links.

---

## Technology Stack

- **Machine Learning**: TensorFlow.js, Teachable Machine Image Model
- **Programming**: JavaScript (ES6+), CSS3 (Modern UI/HUD), HTML5
- **Media**: MediaRecorder API (Video Processing), Web Audio API
- **Logistics**: Internal event-driven logic kernel for rule processing

---

## Challenges & Evolution

### Training & Accuracy
The initial hurdle was adapting 2020-era models for modern real-time inference. We overcame this by implementing a **Smoothing Window Algorithm** in the logic kernel to reduce "flicker" and false positives.

### Real-Time Performance
Balancing the heavy load of local dashcam recording (MediaRecorder) while simultaneously running neural network inference on every frame was solved by optimizing chunk collection and using VP9 encoding where available.

---

## How to Run & Test
1st step use the hosted link (drive-watch-three.vercel.app)

MANUALLY

1. **Clone the Repository**:  
   `git clone https://github.com/oteniyatobi/drive--watch.git`
2. **Open the App**: Launch `index.html` in any modern browser.
3. **Initialize**: 
   - Ensure your dashcam/webcam is connected.
   - Click **START MONITORING**.
4. **Experience the AI**: 
   - Close your eyes to simulate fatigue.
   - At **1s**: The warning beeps begin.
   - At **4s**: The high-intensity siren triggers and an **Instant Incident Clip** link appears in the log.
5. **Export Data**: Click **END SESSION** to compile the full trip recording.

---

## Future Roadmap

- [ ] **Hardware Integration**: Direct API interaction with specialized IR dashcam hardware.
- [ ] **Cloud Sync**: Automatic incident uploading to a centralized fleet management portal.
- [ ] **Multi-Class Detection**: Adding distracted driving detection (phone usage, smoking).
- [ ] **Geo-Tagging**: Real GPS integration via mobile browser API.

---

*This project is a concept-to-prototype safe-driving solution demonstrating the powerful integration of AI, modern front-end development, and media processing.*
