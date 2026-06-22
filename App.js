import React, { useState, useEffect, useRef } from 'react';
import { Text, View, StyleSheet, TouchableOpacity } from 'react-native';
import * as Location from 'expo-location';
import { Magnetometer } from 'expo-sensors';
import { useAudioPlayer } from 'expo-audio';

// Felles matematikk for jordkloden
function getDistanceInMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

function getBearing(lat1, lon1, lat2, lon2) {
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const y = Math.sin(dLon) * Math.cos(lat2 * Math.PI / 180);
  const x = Math.cos(lat1 * Math.PI / 180) * Math.sin(lat2 * Math.PI / 180) - Math.sin(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.cos(dLon);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

export default function App() {
  const [screen, setScreen] = useState('MENU'); // MENU, REBUS, SONAR
  const [location, setLocation] = useState(null);
  const [heading, setHeading] = useState(0);
  const [statusText, setStatusText] = useState('Starter...');

  // Spill-spesifikk data
  const [rebusPosts, setRebusPosts] = useState([]);
  const [currentRebusIndex, setCurrentRebusIndex] = useState(0);
  const [sonarTreasures, setSonarTreasures] = useState([]);
  
  // Lyder og referanser
  const pingPlayer = useAudioPlayer({ uri: 'https://google.com' });
  const successPlayer = useAudioPlayer({ uri: 'https://google.com' });
  const audioIntervalRef = useRef(null);
  const closestDistanceRef = useRef(999);
  const currentAngleDiffRef = useRef(360);

  // Felles GPS og Gyro Tracker
  useEffect(() => {
    let gpsSub, gyroSub;

    const startTracking = async () => {
      let { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;

      // Start GPS
      gpsSub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.High, timeInterval: 1000, distanceInterval: 1 },
        (newLoc) => setLocation(newLoc)
      );

      // Start Gyro/Kompass
      Magnetometer.setUpdateInterval(100);
      gyroSub = Magnetometer.addListener((data) => {
        let angle = Math.atan2(data.y, data.x) * (180 / Math.PI);
        setHeading((angle + 360) % 360);
      });
    };

    if (screen !== 'MENU') startTracking();

    return () => {
      if (gpsSub) gpsSub.remove();
      if (gyroSub) gyroSub.remove();
      if (audioIntervalRef.current) clearInterval(audioIntervalRef.current);
    };
  }, [screen]);

  // LOGIKK: 1. REBUS (2 poster, generert opptil 2 km unna)
  const startRebus = async () => {
    let startPos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    const posts = [];
    for (let i = 0; i < 2; i++) {
      const dist = 500 + Math.random() * 1500; // Mellom 500m og 2km unna
      const angle = Math.random() * 2 * Math.PI;
      posts.push({
        latitude: startPos.coords.latitude + ((dist * Math.cos(angle)) / 6371000) * (180 / Math.PI),
        longitude: startPos.coords.longitude + ((dist * Math.sin(angle)) / (6371000 * Math.cos(startPos.coords.latitude * Math.PI / 180))) * (180 / Math.PI),
        found: false
      });
    }
    setRebusPosts(posts);
    setCurrentRebusIndex(0);
    setScreen('REBUS');
  };

  useEffect(() => {
    if (screen === 'REBUS' && location && rebusPosts[currentRebusIndex]) {
      const post = rebusPosts[currentRebusIndex];
      const d = getDistanceInMeters(location.coords.latitude, location.coords.longitude, post.latitude, post.longitude);
      
      if (d <= 15) { // Funnet innenfor 15 meter (siden det er 2 km radius)
        successPlayer.play();
        if (currentRebusIndex < 1) {
          setCurrentRebusIndex(1);
          setStatusText("Post 1 funnet! Gå mot post 2.");
        } else {
          setStatusText("HURRA! Begge rebuspostene er funnet!");
        }
      } else {
        setStatusText(`Avstand til post ${currentRebusIndex + 1}: ${d.toFixed(0)} meter.`);
      }
    }
  }, [location, screen, currentRebusIndex, rebusPosts]);


  // LOGIKK: 2. BARN SONAR (3 skatter, 40m diameter = 20m radius fra start, GPS + Gyro)
  const startSonar = async () => {
    let startPos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
    const treasures = [];
    for (let i = 0; i < 3; i++) {
      const dist = Math.random() * 20; // 40 meter diameter betyr maks 20 meter unna start
      const angle = Math.random() * 2 * Math.PI;
      treasures.push({
        latitude: startPos.coords.latitude + ((dist * Math.cos(angle)) / 6371000) * (180 / Math.PI),
        longitude: startPos.coords.longitude + ((dist * Math.sin(angle)) / (6371000 * Math.cos(startPos.coords.latitude * Math.PI / 180))) * (180 / Math.PI),
        found: false
      });
    }
    setSonarTreasures(treasures);
    setScreen('SONAR');
    startAudioLoop();
  };

  useEffect(() => {
    if (screen === 'SONAR' && location && sonarTreasures.length > 0) {
      let closest = 999;
      let angleDiff = 360;
      let updated = false;

      const nextTreasures = sonarTreasures.map((t) => {
        if (t.found) return t;
        const d = getDistanceInMeters(location.coords.latitude, location.coords.longitude, t.latitude, t.longitude);
        if (d < closest) {
          closest = d;
          const bearing = getBearing(location.coords.latitude, location.coords.longitude, t.latitude, t.longitude);
          const diff = Math.abs(heading - bearing);
          angleDiff = diff > 180 ? 360 - diff : diff;
        }
        if (d <= 4 && angleDiff <= 25) { // Krav: Under 4m unna OG peker riktig vei (gyro)
          successPlayer.play();
          updated = true;
          return { ...t, found: true };
        }
        return t;
      });

      closestDistanceRef.current = closest;
      currentAngleDiffRef.current = angleDiff;
      if (updated) setSonarTreasures(nextTreasures);
    }
  }, [location, heading, screen, sonarTreasures]);

  const startAudioLoop = () => {
    if (audioIntervalRef.current) clearInterval(audioIntervalRef.current);
    const loop = () => {
      if (pingPlayer) { pingPlayer.seekTo(0); pingPlayer.play(); }
      let delay = 2000;
      const d = closestDistanceRef.current;
      const a = currentAngleDiffRef.current;
      if (d < 6 && a < 30) delay = 250; // Det brenner og du peker rett på skatten!
      else if (d < 12 && a < 45) delay = 600;
      else if (d < 20) delay = 1200;
      audioIntervalRef.current = setTimeout(loop, delay);
    };
    audioIntervalRef.current = setTimeout(loop, 1000);
  };

  // SKJERMVISNINGER
  if (screen === 'MENU') {
    return (
      <View style={styles.container}>
        <Text style={styles.title}>Modus-tester</Text>
        <TouchableOpacity style={[styles.btn, {backgroundColor: '#3B82F6'}]} onPress={startRebus}>
          <Text style={styles.btnText}>REBUS MODUS (2km)</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[styles.btn, {backgroundColor: '#10B981', marginTop: 20}]} onPress={startSonar}>
          <Text style={styles.btnText}>BARN MODUS (Sonar/Gyro)</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const remainingSonar = sonarTreasures.filter(t => !t.found).length;

  return (
    <View style={[styles.container, {backgroundColor: screen === 'REBUS' ? '#1E3A8A' : '#064E3B'}]}>
      <Text style={styles.title}>{screen === 'REBUS' ? '🏃‍♂️ Rebus Test' : '📡 Sonar Gyro Test'}</Text>
      
      <View style={styles.card}>
        {screen === 'REBUS' ? (
          <Text style={styles.infoText}>{statusText}</Text>
        ) : (
          <View style={{alignItems: 'center'}}>
            <Text style={styles.infoText}>{remainingSonar === 0 ? "🎉 Alle 3 skatter funnet!" : `${remainingSonar} skatter igjen.`}</Text>
            {remainingSonar > 0 && (
              <Text style={[styles.gyroHint, {color: currentAngleDiffRef.current < 30 ? '#10B981' : '#F59E0B'}]}>
                {currentAngleDiffRef.current < 30 ? "🎯 Riktig retning!" : "🔄 Snu deg rundt..."}
              </Text>
            )}
          </View>
        )}
      </View>

      <TouchableOpacity style={styles.backBtn} onPress={() => setScreen('MENU')}>
        <Text style={styles.backBtnText}>Avslutt test</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0F172A', justifyContent: 'center', alignItems: 'center', padding: 20 },
  title: { fontSize: 32, fontWeight: 'bold', color: '#fff', marginBottom: 40 },
  btn: { width: '100%', paddingVertical: 20, borderRadius: 15, alignItems: 'center', elevation: 5 },
  btnText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
  card: { backgroundColor: '#fff', padding: 30, borderRadius: 20, width: '100%', alignItems: 'center', minHeight: 150, justifyContent: 'center' },
  infoText: { fontSize: 20, fontWeight: '600', color: '#1F2937', textAlign: 'center' },
  gyroHint: { fontSize: 22, fontWeight: 'bold', marginTop: 15 },
  backBtn: { marginTop: 40, borderBottomWidth: 1, borderBottomColor: '#94A3B8' },
  backBtnText: { color: '#94A3B8', fontSize: 16 }
});