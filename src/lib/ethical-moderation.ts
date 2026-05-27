/**
 * SAIGE Ethical Moderation Layer
 * 
 * Integrates with the SAIGE (Systems-Aware Independently-Governing Ethics)
 * Buddhist ethics framework to evaluate and moderate AI responses.
 * 
 * Live worker: https://buddhist-ai-worker.mistykmedia.workers.dev
 */

export interface EthicalScore {
  /** Harm score 0-1 (lower is better) */
  harm: number;
  /** Non-harm principle 0-10 */
  ahimsa: number;
  /** Truthfulness principle 0-10 */
  sacca: number;
  /** Compassion principle 0-10 */
  karuna: number;
  /** Wisdom principle 0-10 */
  panna: number;
  /** Equanimity principle 0-10 */
  upekkha: number;
  /** Overall composite score - weighted combination of all dimensions */
  composite: number;
  /** Detailed scoring breakdown if available */
  details?: {
    harmDimensions?: {
      deception: number;
      harshness: number;
      omission: number;
      manipulation: number;
    };
    calibrationScore?: number;
    coherenceScore?: number;
  };
}

export interface EthicsEvaluationResult {
  /** Whether the response passed ethical thresholds */
  passed: boolean;
  /** The raw ethical scores */
  scores: EthicalScore;
  /** Reason for failure if applicable */
  failureReason?: string;
  /** Suggested improvement guidance */
  guidance?: string;
  /** Timestamp of evaluation */
  evaluatedAt: string;
}

// Thresholds for ethical acceptance
const DEFAULT_THRESHOLDS = {
  /** Maximum acceptable harm (0-1 scale) */
  maxHarm: 0.25,
  /** Minimum composite score required */
  minComposite: 5.0,
  /** Minimum score for any single principle */
  minPrinciple: 3.0,
};

/**
 * Evaluates a conversation using the SAIGE ethics framework
 */
export async function evaluateEthics(
  userMessage: string,
  assistantResponse: string,
  saigeEndpoint: string = 'https://buddhist-ai-worker.mistykmedia.workers.dev'
): Promise<EthicsEvaluationResult> {
  const scenario = `User: ${userMessage}\nAssistant: ${assistantResponse}`;
  
  try {
    const response = await fetch(`${saigeEndpoint}/get-scenario`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        scenario,
        context: 'chat-conversation',
      }),
    });

    if (!response.ok) {
      console.error(`[SAIGE] API error: ${response.status} ${response.statusText}`);
      // Return permissive result on API failure to avoid blocking legitimate traffic
      return {
        passed: true,
        scores: {
          harm: 0,
          ahimsa: 7,
          sacca: 7,
          karuna: 7,
          panna: 7,
          upekkha: 7,
          composite: 7,
        },
        failureReason: undefined,
        guidance: 'SAIGE evaluation unavailable - allowing response',
        evaluatedAt: new Date().toISOString(),
      };
    }

    const data = await response.json() as Record<string, any>;
    
    // Parse SAIGE response format
    const scores: EthicalScore = {
      harm: data.harm_score ?? data.harm?.total ?? 0,
      ahimsa: data.buddhist_score?.ahimsa ?? data.ahimsa ?? 7,
      sacca: data.buddhist_score?.sacca ?? data.sacca ?? 7,
      karuna: data.buddhist_score?.karuna ?? data.karuna ?? 7,
      panna: data.buddhist_score?.panna ?? data.panna ?? 7,
      upekkha: data.buddhist_score?.upekkha ?? data.upekkha ?? 7,
      composite: data.composite_score ?? data.composite ?? calculateComposite(data),
      details: {
        harmDimensions: data.harm?.dimensions,
        calibrationScore: data.calibration_score,
        coherenceScore: data.coherence_score,
      },
    };

    return evaluateAgainstThresholds(scores);
  } catch (error) {
    console.error('[SAIGE] Evaluation error:', error);
    // Fail open - don't block on errors
    return {
      passed: true,
      scores: {
        harm: 0,
        ahimsa: 7,
        sacca: 7,
        karuna: 7,
        panna: 7,
        upekkha: 7,
        composite: 7,
      },
      failureReason: undefined,
      guidance: 'SAIGE evaluation failed - allowing response',
      evaluatedAt: new Date().toISOString(),
    };
  }
}

/**
 * Calculate composite score from individual components
 * Formula: Buddhist×0.35 + Calibration×0.30 + Coherence×0.20 + (1−Harm)×10×0.15
 */
function calculateComposite(data: any): number {
  const buddhist = data.buddhist_score?.average ?? 
    ((data.ahimsa + data.sacca + data.karuna + data.panna + data.upekkha) / 5);
  const calibration = data.calibration_score ?? 7;
  const coherence = data.coherence_score ?? 7;
  const harm = data.harm_score ?? data.harm?.total ?? 0;
  
  return (
    buddhist * 0.35 +
    calibration * 0.30 +
    coherence * 0.20 +
    (1 - harm) * 10 * 0.15
  );
}

/**
 * Evaluate scores against ethical thresholds
 */
function evaluateAgainstThresholds(scores: EthicalScore): EthicsEvaluationResult {
  const issues: string[] = [];
  
  if (scores.harm > DEFAULT_THRESHOLDS.maxHarm) {
    issues.push(`Harm score ${scores.harm.toFixed(2)} exceeds threshold ${DEFAULT_THRESHOLDS.maxHarm}`);
  }
  
  if (scores.composite < DEFAULT_THRESHOLDS.minComposite) {
    issues.push(`Composite score ${scores.composite.toFixed(2)} below minimum ${DEFAULT_THRESHOLDS.minComposite}`);
  }
  
  // Check individual principles
  const principles = [
    { name: 'Ahimsa (non-harm)', score: scores.ahimsa },
    { name: 'Sacca (truthfulness)', score: scores.sacca },
    { name: 'Karuna (compassion)', score: scores.karuna },
    { name: 'Panna (wisdom)', score: scores.panna },
    { name: 'Upekkha (equanimity)', score: scores.upekkha },
  ];
  
  for (const principle of principles) {
    if (principle.score < DEFAULT_THRESHOLDS.minPrinciple) {
      issues.push(`${principle.name} score ${principle.score.toFixed(2)} below minimum ${DEFAULT_THRESHOLDS.minPrinciple}`);
    }
  }

  const passed = issues.length === 0;
  
  return {
    passed,
    scores,
    failureReason: passed ? undefined : issues.join('; '),
    guidance: passed 
      ? undefined 
      : generateGuidance(scores, principles),
    evaluatedAt: new Date().toISOString(),
  };
}

/**
 * Generate improvement guidance based on low-scoring areas
 */
function generateGuidance(
  scores: EthicalScore, 
  principles: Array<{ name: string; score: number }>
): string {
  const lowPrinciples = principles.filter(p => p.score < DEFAULT_THRESHOLDS.minPrinciple);
  
  if (scores.harm > 0.5) {
    return 'Response may cause significant harm. Consider rewriting with greater care for user wellbeing.';
  }
  
  if (lowPrinciples.length > 0) {
    const principleNames = lowPrinciples.map(p => p.name.split(' ')[0]).join(', ');
    return `Response could better embody: ${principleNames}. Consider these Buddhist principles in your response.`;
  }
  
  return 'Response meets minimum standards but could be improved.';
}

/**
 * Check if ethical moderation is enabled
 */
export function isEthicalModerationEnabled(env: { SAIGE_ENDPOINT?: string }): boolean {
  return !!env.SAIGE_ENDPOINT;
}

/**
 * Format ethical scores for logging/observability
 */
export function formatEthicsLog(result: EthicsEvaluationResult): Record<string, number | string | boolean> {
  return {
    'saige.passed': result.passed,
    'saige.harm': result.scores.harm,
    'saige.composite': result.scores.composite,
    'saige.ahimsa': result.scores.ahimsa,
    'saige.sacca': result.scores.sacca,
    'saige.karuna': result.scores.karuna,
    'saige.panna': result.scores.panna,
    'saige.upekkha': result.scores.upekkha,
    'saige.evaluated_at': result.evaluatedAt,
    ...(result.failureReason && { 'saige.failure_reason': result.failureReason }),
  };
}
