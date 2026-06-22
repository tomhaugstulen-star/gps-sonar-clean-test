import React, { useEffect, useMemo, useState } from "react";
import { SafeAreaView, StyleSheet, Text, View } from "react-native";
import MapView, { Circle, Marker } from "react-native-maps";
import * as Location from "expo-location";

/**
 * KART + GPS-TEST
 *
 * Dette er fortsatt kun testgrunnlaget.
 * Ingen rebusflyt, ingen spørsmål, ingen poståpning.
 *
 * Appen henter telefonens GPS-posisjon og lager én testpost 50 meter nord for deg.
 * Din faktiske posisjon lagres ikke i repo. Posten beregnes lokalt på telefonen.
 */
const TEST_DISTANCE_METERS = 50;
const EARTH_RADIUS_METERS = 6371000;

function toDegrees(radians) {
  return radians * (180 / Math.PI);
}

function toRadians(degrees) {
  return degrees * (Math.PI / 180);
}

function destinationPoint(start, distanceMeters, bearingDegrees) {
  const bearing = toRadians(bearingDegrees);
  const angularDistance = distanceMeters / EARTH_RADIUS_METERS;
  const lat1 = toRadians(start.latitude);
  const lon1 = toRadians(start.longitude);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angularDistance) +
      Math.cos(lat1) * Math.sin(angularDistance) * Math.cos(bearing)
  );

  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(bearing) * Math.sin(angularDistance) * Math.cos(lat1),
      Math.cos(angularDistance) - Math.sin(lat1) * Math.sin(lat2)
    );

  return {
    latitude: toDegrees(lat2),
    longitude: toDegrees(lon2),
  };
}

function makeRegion(currentPosition, testPost) {
  if (!currentPosition) {
    return {
      latitude: 59.91095,
      longitude: 10.7532,
      latitudeDelta: 0.004,
      longitudeDelta: 0.004,
    };
  }

  if (!testPost) {
    return {
      latitude: currentPosition.latitude,
      longitude: currentPosition.longitude,
      latitudeDelta: 0.003,
      longitudeDelta: 0.003,
    };
  }

  return {
    latitude: (currentPosition.latitude + testPost.latitude) / 2,
    longitude: (currentPosition.longitude + testPost.longitude) / 2,
    latitudeDelta: 0.003,
    longitudeDelta: 0.003,
  };
}

function formatMeters(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "ukjent";
  }

  return `${Math.round(value)} m`;
}

export default function App() {
  const [status, setStatus] = useState("Starter GPS...");
  const [location, setLocation] = useState(null);

  useEffect(() => {
    let subscription;
    let mounted = true;

    async function startGps() {
      try {
        const servicesEnabled = await Location.hasServicesEnabledAsync();

        if (!servicesEnabled) {
          setStatus("GPS er av. Slå på posisjonstjenester.");
          return;
        }

        const permission = await Location.requestForegroundPermissionsAsync();

        if (permission.status !== "granted") {
          setStatus("GPS-tillatelse mangler.");
          return;
        }

        setStatus("GPS aktiv. Henter posisjon...");

        const firstFix = await Location.getCurrentPositionAsync({
          accuracy: Location.Accuracy.High,
        });

        if (mounted) {
          setLocation(firstFix);
          setStatus("GPS aktiv.");
        }

        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 1000,
            distanceInterval: 1,
          },
          (nextLocation) => {
            if (mounted) {
              setLocation(nextLocation);
              setStatus("GPS aktiv.");
            }
          }
        );
      } catch (error) {
        console.log("GPS-feil:", error?.message || error);
        if (mounted) {
          setStatus("GPS-feil. Se Metro-logg.");
        }
      }
    }

    startGps();

    return () => {
      mounted = false;
      if (subscription) subscription.remove();
    };
  }, []);

  const currentPosition = location
    ? {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      }
    : null;

  const testPost = useMemo(() => {
    if (!currentPosition) return null;

    return {
      id: "post-50m",
      title: "Testpost 50 m nord",
      ...destinationPoint(currentPosition, TEST_DISTANCE_METERS, 0),
    };
  }, [currentPosition]);

  const region = useMemo(() => makeRegion(currentPosition, testPost), [currentPosition, testPost]);

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.kicker}>Kart + GPS-test</Text>
        <Text style={styles.title}>Én post 50 meter unna</Text>
        <Text style={styles.bodyText}>
          Posten beregnes lokalt fra din GPS-posisjon. Ingen private koordinater er hardkodet.
        </Text>
        <Text style={styles.statusText}>{status}</Text>
      </View>

      <MapView
        style={styles.map}
        region={region}
        showsUserLocation={!!currentPosition}
        showsMyLocationButton
      >
        {currentPosition ? (
          <Marker
            coordinate={currentPosition}
            title="Din GPS-posisjon"
            description={`Nøyaktighet: ${formatMeters(location?.coords?.accuracy)}`}
            pinColor="blue"
          />
        ) : null}

        {testPost ? (
          <>
            <Circle
              center={{ latitude: testPost.latitude, longitude: testPost.longitude }}
              radius={15}
              strokeColor="#f97316"
              fillColor="rgba(249, 115, 22, 0.18)"
            />
            <Marker
              coordinate={{ latitude: testPost.latitude, longitude: testPost.longitude }}
              title={testPost.title}
              description="Beregnet 50 meter nord for din posisjon"
              pinColor="orange"
            />
          </>
        ) : null}
      </MapView>

      <View style={styles.footer}>
        <Text style={styles.footerTitle}>Testkriterium</Text>
        <Text style={styles.bodyText}>
          Du skal se din posisjon og én oransje post ca. 50 meter nord for deg.
        </Text>
        <Text style={styles.debugText}>GPS-nøyaktighet: {formatMeters(location?.coords?.accuracy)}</Text>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#101114",
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 18,
    paddingBottom: 14,
  },
  kicker: {
    color: "#9ca3af",
    fontSize: 14,
    fontWeight: "700",
    letterSpacing: 0.8,
    textTransform: "uppercase",
  },
  title: {
    color: "#ffffff",
    fontSize: 30,
    fontWeight: "800",
    marginTop: 6,
  },
  bodyText: {
    color: "#d1d5db",
    fontSize: 15,
    lineHeight: 21,
    marginTop: 8,
  },
  statusText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
    marginTop: 10,
  },
  map: {
    flex: 1,
  },
  footer: {
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
    borderTopColor: "#2d3340",
    backgroundColor: "#1c1f26",
  },
  footerTitle: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "800",
  },
  debugText: {
    color: "#9ca3af",
    fontSize: 13,
    lineHeight: 19,
    marginTop: 8,
  },
});
