/**
 * Statistical Change-Point Detector using CUSUM (Cumulative Sum Control Chart)
 * Spec Section 27: Change-Point Detection
 * Output: change_point_score (0.0 to 1.0)
 * 0.0 - 0.3 = normal
 * 0.3 - 0.6 = suspicious
 * 0.6 - 0.8 = transition
 * 0.8 - 1.0 = strong regime change
 */

export class CusumChangePointDetector {
  private sHigh = 0;
  private sLow = 0;
  private readonly k: number; // Reference value / slack
  private readonly h: number; // Decision threshold

  constructor(k = 0.5, h = 5.0) {
    this.k = k;
    this.h = h;
  }

  /**
   * Updates CUSUM with a normalized standardized value (e.g. Z-score of volume/CVD).
   * @param zScore standard score of current market observation
   */
  update(zScore: number): number {
    // Upper CUSUM (detects sudden upward shift in buying flow)
    this.sHigh = Math.max(0, this.sHigh + (zScore - this.k));

    // Lower CUSUM (detects sudden collapse)
    this.sLow = Math.max(0, this.sLow - (zScore + this.k));

    // Normalize to 0.0 - 1.0 based on decision threshold h
    const rawScore = this.sHigh / this.h;
    return Math.min(1.0, Math.max(0.0, Math.round(rawScore * 100) / 100));
  }

  reset(): void {
    this.sHigh = 0;
    this.sLow = 0;
  }

  getCurrentScore(): number {
    return Math.min(1.0, Math.max(0.0, Math.round((this.sHigh / this.h) * 100) / 100));
  }
}
